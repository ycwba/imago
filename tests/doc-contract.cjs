/* 文档契约判据：写的**设计规范**必须与代码一致 —— 文档不许说谎。
   文档里最容易漂的是「令牌叫什么 / 哪一段是主题色 / 公共类有哪些 / 断点几档 / 判据几条 /
   画面几档」这类**能对着代码数出来**的陈述。代码改了而文档没改，下一个人就照着过期文档写。

   范围：设计规范（硬约束）里能机械核对的那些陈述。 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support.cjs');

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
for (const t of ['--sp-16', '--fs-13', '--radius-10', '--acc-tint-18', '--sz-ico', '--sz-ctl', '--sz-ctl-sm', '--sz-chip', '--sz-head',
  '--sz-tile', '--sz-thumb-h', '--sz-card', '--sz-scroll', '--a-10', '--a-90', '--hair', '--shadow-1', '--dur-180']) {
  ok(new RegExp('\\' + t + '\\s*:').test(tokens), '令牌表里没有 ' + t + '（设计规范点名了它）');
}
ok(!/--sp-1\s*:\s*4px/.test(tokens) && !/--fs-1\s*:\s*12px/.test(tokens) && !/--radius-1\s*:\s*6px/.test(tokens),
  '令牌表回退到了「序号=档位」的写法（--sp-1:4px 之类）');
const spVals = [...tokens.matchAll(/--sp-([\d.]+)\s*:/g)].map(m => Number(m[1]));
ok(spVals.length === 8, '间距档位应为 8 枚（终表 2/4/8/12/16/24/32/64），实际 ' + spVals.length);
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
for (const t of ['--acc-tint-10', '--acc-line-32', '--warn-tint', '--sel-bg']) {
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
/* 深色档里出现的名字必须属于 ①（语义色）/ ②（派生色）/ ③b（标记色）或阴影 —— 拼错的会静默失效。
   ② 那一族（--atbg 文字底纹 / --sel-bg 选中底纹）深浅两档的透明度本来就该不同：
   深色档的底是深灰、强调色是亮色，同一档透明度压在同一族文字上会把对比推到 4.5 以下。 */
const dark = (tokensRaw.split('html[data-theme="dark"] {')[1] || '').split('}')[0];
const s1Names = new Set([...s1.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const s2Names = new Set([...s2.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const s3bNames = new Set([...s3b.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
for (const m of dark.matchAll(/(--[\w-]+)\s*:/g)) {
  ok(s1Names.has(m[1]) || s2Names.has(m[1]) || s3bNames.has(m[1]) || /^--shadow-/.test(m[1]),
    '深色档里的 ' + m[1] + ' 不在 ① 主题色段 / ② 派生色段 / ③b 标记色段里（拼错会静默失效）');
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

/* ---------- 断点：媒体查询里不能用变量，只能靠「一份名单 + 判据」防漂移 ----------
   名单住在 tests/support.cjs 的 BREAKPOINTS（静态判据 G22 读的就是它）。
   这一档数三件事：代码里用到的档位、登记的名单、设计规范里那一行 —— 三者必须同一份。 */
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
ok(bps.size === S.BREAKPOINTS.length && S.BREAKPOINTS.every(b => bps.has(b)),
  '断点档位与登记的名单不一致（登记 ' + S.BREAKPOINTS.length + ' 档，代码 ' + bps.size + ' 档：' + [...bps].sort((a, b) => a - b).join(' ') + '）');
const docBp = /当前登记的 (\d+) 档：([\d \/]+)/.exec(doc) || [];
ok(Number(docBp[1]) === S.BREAKPOINTS.length
  && (docBp[2] || '').split('/').map(s => Number(s.trim())).join(' ') === S.BREAKPOINTS.join(' '),
  '设计规范的断点那一行与登记的名单不一致（规范写的是「' + (docBp[2] || '没有那一行') + '」）');

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
ok(nGuards === 24, '静态判据应为 24 条，实际 ' + nGuards);
for (const g of ['G18', 'G19', 'G20', 'G21', 'G22', 'G23', 'G24', 'G25']) {
  ok(guardSrc.includes("key: '" + g + "'"), '判据 ' + g + ' 不在了（设计规范点名了它）');
}
const nVis = Object.keys(JSON.parse(read('tests/fixtures/visual/fingerprints.json')).screens).length;
ok(nVis === 48, '视觉画面应为 48 档，实际 ' + nVis);
const nE2e = fs.readdirSync(path.join(ROOT, 'tests/e2e')).filter(f => f.endsWith('.cjs')).length;
/* 口径：tests/e2e/ 里的 .cjs 文件数（判据 + harness）。新增一条判据要在这里改数字，
   文档里的条数也得跟着改 ——「文档不许说谎」。 */
ok(nE2e === 57, 'e2e 应为 57 条，实际 ' + nE2e);

/* ---------- 版本与清单：README / CHANGELOG 不许与代码漂移 ----------
   和上面那几档同一个立场：只盯「能对着代码数出来」的陈述。 */
const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const routesSrc = read('web/core/routes.js');
/* 路由表每页一行，行长这样：{ file: 'director.html', ... }；别名表里的 'app.html' 不是这一族。 */
const nRoutes = (routesSrc.match(/\{\s*file:\s*'/g) || []).length;
ok(nRoutes > 0 && new RegExp('共\\s*' + nRoutes + '\\s*条').test(readme),
  'README 的页面数与路由表条数不一致（路由表 ' + nRoutes + ' 条）');
const mentioned = new Set([...readme.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)].map(m => m[1]));
for (const s of Object.keys(pkg.scripts)) ok(mentioned.has(s), 'README 的 scripts 清单少了 npm run ' + s);
for (const m of mentioned) ok(pkg.scripts[m] !== undefined, 'README 写了不存在的命令 npm run ' + m);
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
ok(fs.existsSync(changelogPath), 'CHANGELOG.md 不存在');
if (fs.existsSync(changelogPath)) {
  const first = /^##\s+(\d+\.\d+\.\d+)\s/m.exec(fs.readFileSync(changelogPath, 'utf8'));
  ok(!!first && first[1] === pkg.version,
    'CHANGELOG 最新版本与 package.json 的 version 不一致（'
    + (first ? first[1] : '没有版本标题') + ' / ' + pkg.version + '）');
}

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
