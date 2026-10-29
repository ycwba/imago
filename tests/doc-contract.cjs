/* 文档契约判据：写的**设计规范**必须与代码一致 —— 文档不许说谎。
   文档里最容易漂的是「令牌叫什么 / 哪一段是主题色 / 公共类有哪些 / 断点几档 / 判据几条 /
   画面几档」这类**能对着代码数出来**的陈述。代码改了而文档没改，下一个人就照着过期文档写。

   范围：设计规范（硬约束）里能机械核对的那些陈述。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* 注释里的字样不算 —— 文档里解释历史写法的那句话会提到旧令牌名。 */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

let bad = 0, n = 0;
function ok(cond, msg) {
  n++;
  if (!cond) { bad++; console.log('  ✗ ' + msg); }
}

const doc = read('AGENTS.md');
const tokens = stripComments(read('web/styles/tokens.css'));
const ui = stripComments(read('web/styles/ui.css'));
const wb = stripComments(read('web/styles/wb.css'));
const pub = ui + '\n' + wb;

/* ---------- 令牌：文档点名的那些必须存在，且不许回退到「序号=档位」 ---------- */
for (const t of ['--sp-14', '--fs-12-5', '--radius-10', '--acc-tint-18', '--sz-ico', '--sz-ctl', '--sz-tile',
  '--sz-thumb-h', '--sz-card', '--sz-scroll', '--sz-wb', '--a-10', '--a-90', '--hair', '--shadow-1', '--dur-180']) {
  ok(new RegExp('\\' + t + '\\s*:').test(tokens), '令牌表里没有 ' + t + '（设计规范点名了它）');
}
ok(!/--sp-1\s*:\s*4px/.test(tokens) && !/--fs-1\s*:\s*12px/.test(tokens) && !/--radius-1\s*:\s*6px/.test(tokens),
  '令牌表回退到了「序号=档位」的写法（--sp-1:4px 之类）');
const spVals = [...tokens.matchAll(/--sp-([\d.]+)\s*:/g)].map(m => Number(m[1]));
ok(spVals.length === 29, '间距档位应为 29 枚（主档 6 + 补档 23），实际 ' + spVals.length);
const aVals = [...tokens.matchAll(/--a-([\d.]+)\s*:/g)].map(m => m[1]);
ok(aVals.length === 21, '透明度阶梯应为 21 档，实际 ' + aVals.length);
ok(!/--sp-17\s*:|--sp-21\s*:|--sp-23\s*:|--sp-25\s*:/.test(tokens), '间距档位里出现了没登记的值');

/* ---------- 主题分段：①主题色 / ①b固定 / ②派生 / ③固定中性 / ③b导演台标记色 ----------
   段标题本身是注释，所以**先按标题切、再在段内剥注释**（顺序反了段就没了）。 */
const tokensRaw = read('web/styles/tokens.css');
const section = (from, to) => {
  const a = tokensRaw.indexOf(from);
  if (a < 0) return '';
  const b = tokensRaw.indexOf(to, a);
  return stripComments(tokensRaw.slice(a, b < 0 ? undefined : b));
};
const s1 = section('① 主题色', '①b');
const s1b = section('①b', '② 派生色');
const s2 = section('② 派生色', '③ 固定中性色');
const s3 = section('③ 固定中性色', '③b 导演台标记色');
const s3b = section('③b 导演台标记色', '尺寸档位：组件尺寸');
ok(s1 && s1b && s2 && s3 && s3b, 'tokens.css 的五段标题（①/①b/②/③/③b）都在');
for (const t of ['--bg', '--panel', '--line', '--txt', '--sub', '--acc', '--acc2', '--ok', '--warn', '--err', '--pri', '--input', '--thumbbg', '--atbg', '--scroll']) {
  ok(new RegExp('\\' + t + '\\s*:').test(s1), '① 主题色段里没有 ' + t);
}
for (const t of ['--on-acc', '--media-bg', '--chart-1', '--chart-12']) {
  ok(new RegExp('\\' + t + '\\s*:').test(s1b), '①b 固定色段里没有 ' + t);
}
for (const t of ['--acc-tint-10', '--acc-line-32', '--warn-tint']) {
  ok(new RegExp('\\' + t + '\\s*:').test(s2), '② 派生色段里没有 ' + t);
}
for (const t of ['--pal-gray', '--pal-slate', '--pal-scrim']) {
  ok(new RegExp('\\' + t + '\\s*:').test(s3), '③ 固定中性色段里没有 ' + t);
}
/* 导演台不再有独立深底作用域：那族「不跟主题走」的固定深底配色必须整体消失，
   深底表面归主题面板色，轨道上的功能标记归 ③b 的 --mark-*（跟主题走）。 */
ok(!/--dir-/.test(tokensRaw), 'tokens.css 里还有导演台那族固定深底配色（导演台不再有独立深底作用域）');
for (const t of ['--mark-cut', '--mark-ready', '--mark-mute', '--mark-loud']) {
  ok(new RegExp('\\' + t + '\\s*:').test(s3b), '③b 导演台标记色段里没有 ' + t);
}
/* 深色档里出现的名字必须属于 ①（语义色）/ ③b（标记色）或阴影 —— 拼错的会静默失效 */
const dark = (tokensRaw.split('html[data-theme="dark"] {')[1] || '').split('}')[0];
const s1Names = new Set([...s1.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const s3bNames = new Set([...s3b.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
for (const m of dark.matchAll(/(--[\w-]+)\s*:/g)) {
  ok(s1Names.has(m[1]) || s3bNames.has(m[1]) || /^--shadow-/.test(m[1]),
    '深色档里的 ' + m[1] + ' 不在 ① 主题色段 / ③b 标记色段里（拼错会静默失效）');
}
/* ③b 的四枚标记色必须在深色档成对覆盖：跟 ① 段主题色一个待遇，
   不成对覆盖就是切到夜间时它们悄悄沿用浅色档的值（浅色下读不出来的那几枚）。 */
const darkNames = new Set([...dark.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
for (const t of ['--mark-cut', '--mark-ready', '--mark-mute', '--mark-loud']) {
  ok(darkNames.has(t), '深色档没覆盖标记色 ' + t + '（切主题时它会静默沿用浅色档的值）');
}

/* ---------- 布局：两种外壳 ---------- */
ok(/\.page-shell \{/.test(ui), 'ui.css 里没有 .page-shell（普通页外壳）');
ok(/^\.wb \{/m.test(wb) && /\.wb \.layout/.test(wb), 'wb.css 里没有 .wb / .wb .layout（工作台外壳）');
ok(!/body\.wb2\s*\{/.test(ui) && !/body\.wb2\s+\S/.test(ui), 'ui.css 里还有 body.wb2 的死代码');
ok(/class="page-main studio-page wb"/.test(read('tools/vue-templates/studio.html')), '工作台模板根元素没挂 .wb');
for (const f of ['chars', 'assets', 'usage', 'settings', 'favorites']) {
  ok(/page-shell/.test(read('tools/vue-templates/' + f + '.html')), f + '.html 没挂 .page-shell');
}

/* ---------- 断点：登记的 11 档（媒体查询里不能用变量，只能靠集合 + 判据） ---------- */
const bps = new Set();
for (const dir of ['web', 'tools']) {
  const walk = d => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'render' || e.name === 'vendor') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|html|js)$/.test(e.name)) {
        for (const m of stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8')).matchAll(/@media\s*\((?:max|min)-width:\s*(\d+)px\)/g)) bps.add(Number(m[1]));
      }
    }
  };
  walk(dir);
}
/* 登记在案的那几档断点（代码里 @media (min|max)-width 用到的）。
   1280 那一档不能加回来：设置页改成两栏两滚之后，右栏那条文档只有 900px 上下，
   两列各 400px 放不下「标签 + 下拉 + 输入框 + 单位」那一行。 */
const docBp = [520, 620, 700, 720, 760, 820, 900, 960, 1100, 1180, 1200];
ok(bps.size === docBp.length && docBp.every(b => bps.has(b)),
  '断点档位与文档不一致（文档 ' + docBp.length + ' 档，代码 ' + bps.size + ' 档：' + [...bps].sort((a, b) => a - b).join(' ') + '）');

/* ---------- 公共样式类：文档那张表里的类必须真的存在 ---------- */
for (const c of ['card', 'card-surface', 'task', 'ap-item', 'pri', 'ghost', 'tool', 'ui-linkbtn',
  'ui-seg', 'chip', 'ui-tag', 'ui-note', 'list-note', 'srcbadge', 'pgroup', 'dd', 'dd-list',
  'dd-btn', 'pinl', 'empty', 'ui-wait', 'toolbar', 'viewtoggle', 'pager-row', 'pginfo',
  'ui-vrow', 'ui-voice', 'ui-cands']) {
  ok(new RegExp('(^|[\\s,>+~])\\.' + c + '(?![\\w-])').test(pub), '公共层里没有 .' + c + '（设计规范点名了它）');
}

/* ---------- 文档里点名的工具 / 判据 / 命令必须存在 ---------- */
for (const f of ['tools/tokenize-css.cjs', 'tools/token-lib.cjs', 'tools/check-vars.cjs',
  'web/styles/tokens.css', 'web/styles/ui.css', 'web/styles/wb.css', 'web/styles/chat.css']) {
  ok(fs.existsSync(path.join(ROOT, f)), '文档提到的 ' + f + ' 不存在');
}
const guardSrc = read('tests/static-guards.cjs');
const nGuards = (guardSrc.match(/key: 'G\d+'/g) || []).length;
ok(nGuards === 22, '静态判据应为 22 条，实际 ' + nGuards);
for (const g of ['G18', 'G19', 'G20', 'G21', 'G22', 'G23']) {
  ok(guardSrc.includes("key: '" + g + "'"), '判据 ' + g + ' 不在了（设计规范点名了它）');
}
const nVis = Object.keys(JSON.parse(read('tests/fixtures/visual/fingerprints.json')).screens).length;
ok(nVis === 44, '视觉画面应为 44 档，实际 ' + nVis);
const nE2e = fs.readdirSync(path.join(ROOT, 'tests/e2e')).filter(f => f.endsWith('.cjs')).length;
/* 口径：tests/e2e/ 里的 .cjs 文件数（判据 + harness）。新增一条判据要在这里改数字，
   文档里的条数也得跟着改 ——「文档不许说谎」。 */
ok(nE2e === 49, 'e2e 应为 49 条，实际 ' + nE2e);

/* ---------- 文档里的远端地址必须与实际远端一致 ----------
   远端**别名**随克隆而异（本机叫 origin、另一份工作副本叫 github），
   所以盯的是**地址** —— 换了仓库地址而文档没改，下一个人就照着过期地址推。 */
try {
  const { execFileSync } = require('child_process');
  const names = execFileSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  if (names.length) {
    const url = execFileSync('git', ['remote', 'get-url', names[0]], { cwd: ROOT, encoding: 'utf8' }).trim();
    ok(doc.includes(url), '文档里的远端地址与实际远端不一致（实际 ' + url + '）');
  }
} catch (e) { /* 没有远端（裸克隆）就跳过 */ }

console.log(bad ? '\n✗ 文档契约：' + bad + ' / ' + n + ' 条对不上' : '\n✓ 文档契约：' + n + ' 条陈述与代码一致');
process.exit(bad ? 1 : 0);
