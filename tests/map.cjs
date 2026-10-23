#!/usr/bin/env node
/* 改动 → 必跑 映射（三档流程的第二档）—— 跑法：
     node tests/map.cjs --changed              按 git 改动列出该跑哪些判据
     node tests/map.cjs --changed --run        列出来并且跑快的那批（≈20 秒）
     node tests/map.cjs --changed --run --e2e  连浏览器判据一起跑（慢，合并前）
     node tests/map.cjs --files web/ui/ui.js   手工点名文件
     node tests/map.cjs --list                 只看映射表与登记表
   两条来源合起来给必跑清单：
     ① 文档表（写在这里就是「文档即代码」，改表要改这里）；
     ② 反查（扫每个判据脚本的源码里提到了哪些 web/… server/… 路径、开的是哪条路由），
        「该 domain 的单测 / 该页的 e2e」由它给出 —— 新增测试不需要回来改这张表。
   浏览器判据默认只列不跑：`test:fast` 的预算是 20 秒，一个 e2e 脚本就要 10~60 秒。
   自己也要被判据管：磁盘上的判据文件必须登记在 all.cjs 里跑过一遍
   —— `routes-smoke` / `static-guards` 就是这么「写好了但从来没跑过」的。 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const abs = p => path.join(root, p);
const read = f => fs.readFileSync(abs(f), 'utf8');

/* ---------- 判据登记表：从 all.cjs 现读，不留第二份清单 ---------- */
function registry() {
  const src = read('tests/all.cjs');
  const at = src.search(/if\s*\(process\.argv\.includes\('--e2e'\)/);
  if (at < 0) throw new Error('tests/all.cjs 里找不到 --e2e 的分段位置，登记表读不出来');
  const ids = seg => [...seg.matchAll(/run\('tests\/(?:e2e\/)?([\w.-]+?)\.(?:cjs|mjs)'/g)].map(m => m[1]);
  return { resident: new Set(ids(src.slice(0, at))), browser: new Set(ids(src.slice(at))) };
}

/* 不是「一条判据」的文件：入口、共用件、以及要手工带参数跑的探针。
   每一条都要有原因 —— 没有原因的缺席就是「写好了但从来没跑过」那一类。 */
const HELPERS = {
  all: '汇总入口本身，不是一条判据',
  map: '本文件：改动→必跑的映射',
  support: '判据脚本共用的件（层表 / 例外登记比对），由别的判据 require',
  /* syntax 现在是 all.cjs 池里的普通一条（run 登记行在），不再是「require 进程内跑」的helper。 */
  harness: '浏览器判据唯一的启动 / 取 Cookie / 打开页面入口（AGENTS.md §13.4），自己不是一条判据',
  watch: 'watch 模式入口：常驻前台跑，触发本文件的 --changed --run，自己不是一条判据',
  anchordry: '素材库锚点的一次性体检，要带参数，不常驻',
  'data-snapshot': '写入型基线：要对真实 .data/.assets 比，只手工跑（AGENTS.md §13.3）',
};
/* 是真判据，但由别处代跑（代跑关系写死在这一份里，不再靠人记）。
   2026-10-21：spa 不再是「由 selfcheck 代跑」—— selfcheck 里那条同步
   spawnSync 正是它 3.8s 慢点的本体（起服务/读盘/重复求值 里的「重复求值」）。
   spa.cjs 现在自己就是 all.cjs 并发池里的独立判据，selfcheck 不再为它垫一句「全绿」。 */
const DELEGATED = {};

function diskTests() {
  /* 以点开头的文件不算判据：`.probe-tables.cjs` 那类是重打例外登记表的草稿工具，要带参数手工跑。 */
  const out = [];
  for (const f of fs.readdirSync(abs('tests'))) {
    if (f.startsWith('.')) continue;
    if (/\.cjs$|\.mjs$/.test(f)) out.push({ id: f.replace(/\.(cjs|mjs)$/, ''), file: 'tests/' + f, tier: 'resident' });
  }
  for (const f of fs.readdirSync(abs('tests/e2e'))) {
    if (f.startsWith('.')) continue;
    if (f.endsWith('.cjs')) out.push({ id: f.replace(/\.cjs$/, ''), file: 'tests/e2e/' + f, tier: 'browser' });
  }
  return out;
}

/* ---------- 反查：判据脚本 ↔ 源码文件 ---------- */
/* shell.html / proxy.js 不在这里反查：每个 e2e 都用 `proxy.base + '/shell.html#…'` 打开页面，
   每一个脚本都“提到”外壳，反查会把一次外壳改动映射成全部浏览器判据（那是噪音不是判据）。
   外壳与代理入口该跑什么由下面的文档表点名。 */
const SRC_RE = /\b((?:web|server|tools)\/[\w./-]+\.(?:js|mjs|cjs|html|css))\b/g;
const ROUTE_RE = /#([a-z][\w-]*)\.html/g;
/* 一条路由对应到哪些落点（页面 / 模板 / 生成物 / 页面 CSS；导演台那一页另有一整棵模块树）。 */
function pageTargets(page) {
  const out = ['web/pages/' + page + '.js', 'tools/vue-templates/' + page + '.html',
    'web/render/' + page + '.js', 'web/styles/spa-' + page + '.css'];
  if (page === 'director') out.push('web/director/');
  return out;
}
function testTouches() {
  const map = new Map();
  for (const t of diskTests()) {
    if (HELPERS[t.id]) continue;
    let src;
    try { src = read(t.file); } catch (e) { continue; }
    const set = new Set();
    let m;
    SRC_RE.lastIndex = 0;
    while ((m = SRC_RE.exec(src))) set.add(m[1]);
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src))) for (const p of pageTargets(m[1])) set.add(p);
    map.set(t.id, [...set]);
  }
  return map;
}

/* ---------- 文档表（外加几条把话说全的行） ---------- */
const ROWS = [
  { key: 'web/domain/**', match: p => p.startsWith('web/domain/'),
    resident: ['core', 'architecture', 'static-guards', 'local-first'], browser: [],
    why: 'domain 层：core 的跨模块契约 + 分层方向 + 静态纪律 + 本机优先身份' },
  { key: 'web/pages/**', match: p => p.startsWith('web/pages/'),
    resident: ['spa', 'selfcheck', 'static-guards'], browser: ['ui-shared'],
    why: '页面：外壳接线（spa/selfcheck）+ 公共件没被页面复制第二份（static-guards/ui-shared）' },
  { key: 'web/ui/**', match: p => p.startsWith('web/ui/'),
    resident: ['ui-catalog', 'selfcheck', 'static-guards'],
    browser: ['ui-shared', 'actions', 'assistant-dock', 'drag-guard'],
    why: '公共件：目录判据 + 列表页/浮层的浏览器判据（「三个列表页」= 收藏 / 素材库 / 资产库那一类）' },
  { key: 'web/director/**', match: p => p.startsWith('web/director/'),
    resident: ['editing', 'local-edit', 'editor-media', 'fcpxml-client'], browser: ['director-perf'],
    why: '导演台：全部 director-* 单测由反查补齐，这一行保底放四件 + perf' },
  { key: 'server/routes/**', match: p => p.startsWith('server/routes/'),
    resident: ['routes-smoke', 'architecture'], browser: ['proxy'],
    why: '路由：工厂的 ctx 注入必须真被调一遍（pick-dir 那一类）' },
  { key: 'server/*-store.js', match: p => /^server\/[\w-]*-store\.js$/.test(p),
    resident: ['routes-smoke', 'local-first', 'index-store'], browser: ['cloud-sync', 'local-chain'],
    why: '落盘：写入可靠性（原子写 / .bak / journal）+ 云同步 + 本机资产的读写链路那一条' },
  { key: 'server/**', match: p => p.startsWith('server/'),
    resident: ['routes-smoke', 'providers-validate', 'relay-retry', 'static-guards', 'static-encoding'],
    browser: ['proxy', 'static-encoding'],
    why: '服务端其它：注册表校验 + 转发闸重试 + 代理行为 + 静态预压缩（同一份判据，e2e 档跑 --live 那一半）' },
  { key: 'web/styles/**', match: p => p.startsWith('web/styles/'),
    resident: ['static-guards'], browser: ['ui-visual'],
    why: '样式：裸色值判据 + 视觉指纹（ui-visual 按改的那一页收，见 --pages 提示）' },
  { key: 'tools/vue-templates/**', match: p => p.startsWith('tools/vue-templates/'),
    resident: ['build-check', 'spa'], browser: [],
    why: '模板：生成物一致性（npm run check 已含 build:check，这里再点名一次）+ 该页 e2e 由反查给' },
  { key: 'web/render/**', match: p => p.startsWith('web/render/'),
    resident: ['build-check', 'spa'], browser: [],
    why: '生成物：只能是没跑 npm run build 或手改了生成文件 —— 两条判据都会红' },
  { key: 'web/core/** · web/app.js · shell.html', match: p => p.startsWith('web/core/') || p === 'web/app.js' || p === 'shell.html',
    resident: ['core', 'spa', 'selfcheck', 'architecture'], browser: ['smoke'],
    why: '外壳/路由/生命周期：路由表唯一性、页面池、控制台错误' },
  { key: 'web/features/**', match: p => p.startsWith('web/features/'),
    resident: ['selfcheck', 'static-guards'],
    browser: ['chat-actions', 'chat-context', 'chat-receipt', 'chat-search-cite', 'actions', 'actions-feedback', 'assistant-dock'],
    why: 'AI 助手：动作契约与上下文预算的浏览器判据都在这一档' },
  { key: 'tests/**', match: p => p.startsWith('tests/'),
    resident: ['architecture', 'routes-smoke', 'static-guards', 'spa'], browser: [],
    why: '判据自身：support/syntax/map 被三份以上判据依赖，四件重判据跟着跑' },
];

/* 每条改动命中哪些行 + 反查命中哪些判据。 */
function plan(files) {
  const touches = testTouches();
  const tierOf = new Map(diskTests().map(t => [t.id, t.tier]));
  const byFile = [];
  const picked = new Set();
  const browserPicked = new Set();
  const rowsPicked = new Set();
  for (const f of files) {
    const rows = ROWS.filter(r => r.match(f));
    const derived = [...touches.entries()].filter(([, set]) => set.some(s => f === s || f.startsWith(s) || s.startsWith(f)))
      .map(([id]) => id);
    for (const r of rows) {
      rowsPicked.add(r.key);
      for (const id of r.resident) picked.add(id);
      for (const id of r.browser) browserPicked.add(id);
    }
    for (const id of derived) {
      if (tierOf.get(id) === 'browser') browserPicked.add(id); else picked.add(id);
    }
    byFile.push({ file: f, rows: rows.map(r => r.key), derived });
  }
  /* selfcheck 不再代跑 spa（那条同步 spawnSync 是 selfcheck 的慢点本体）：
     凡是挑中 selfcheck 的改动，spa.cjs 必须一起进清单，否则外壳判据漏跑。 */
  if (picked.has('selfcheck')) picked.add('spa');
  return { byFile, picked: [...picked], browserPicked: [...browserPicked], rowsPicked: [...rowsPicked] };
}

/* ---------- git：改动从哪来 ---------- */
function gitChanged() {
  let r = cp.spawnSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return { files: split(r.stdout), from: 'git diff --name-only' };
  if (r.error) return { error: 'git 跑不动（' + r.error.message + '）；用 --files 手工点名' };
  r = cp.spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return { error: 'git status 失败（退出码 ' + r.status + '）；用 --files 手工点名' };
  const out = [];
  for (const line of split(r.stdout)) {
    /* porcelain 每行形如 ` M path` / `?? path` / `R  old -> new`：取最后一个路径 */
    const m = /->\s+(.+)$/.exec(line);
    out.push((m ? m[1] : line).trim().replace(/^"|"$/g, ''));
  }
  return { files: out.filter(Boolean), from: 'git status --porcelain' };
}
function split(s) { return String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean); }

/* ---------- 跑 ---------- */
/* 判据子进程优先用「系统 node」跑，不再默认跟着当前 execPath。
   实测（2026-10-21）：全量常驻 managed 54.3s / 系统 45.9s —— 一文件一进程时
   启动开销差被 49 次 spawn 放大。选型优先级：
     ① 环境变量 NODE 显式指定；
     ② PATH 里第一个「不是当前 execPath」且能跑的 node（which/where 现查）；
     ③ 拿不到就回落到 process.execPath —— 绝不能因为找不到系统 node 就把测试跑挂。
   构建与开发依赖（npm run build / check 里的 precompile）仍走 managed，不受这里影响。
   all.cjs / watch.cjs 共用这一份（不另存第二张选型表）。 */
function resolveNode() {
  const runnable = c => { try { return cp.spawnSync(c, ['-e', '0'], { timeout: 10000 }).status === 0; } catch (e) { return false; } };
  let cur = process.execPath;
  try { cur = fs.realpathSync(process.execPath); } catch (e) {}
  const cands = [];
  if (process.env.NODE) cands.push(process.env.NODE);
  else {
    const probe = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' });
    if (probe.status === 0) cands.push(...String(probe.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  }
  for (const c of cands) {
    let real = c;
    try { real = fs.realpathSync(c); } catch (e) {}
    if (real === cur) return process.execPath;    // PATH 里排第一的就是当前进程：没什么可换的
    if (runnable(c)) return c;                    // 找到另一个能跑的 node：按上面的规则用它
  }
  return process.execPath;
}
let testNodeCache = null;
const testNode = () => (testNodeCache || (testNodeCache = resolveNode()));

function fileOf(id) {
  if (fs.existsSync(abs('tests/' + id + '.mjs'))) return 'tests/' + id + '.mjs';
  if (fs.existsSync(abs('tests/' + id + '.cjs'))) return 'tests/' + id + '.cjs';
  if (fs.existsSync(abs('tests/e2e/' + id + '.cjs'))) return 'tests/e2e/' + id + '.cjs';
  return null;
}
function command(id) {
  if (id === 'build-check') return { name: 'npm run build:check', cmd: testNode(), args: ['tools/precompile-vue.cjs', '--check'] };
  const file = fileOf(id);
  if (!file) return null;
  return { name: file, cmd: testNode(), args: [file] };
}
/* --run 逐条记耗时，跑完给一张按耗时降序的清单与总计；
   总计超预算（默认 20s，MAP_BUDGET_MS 可改）就把「最慢的那几条」单独点出来，
   并提示：切 `--run --e2e` 之前先看这份清单（e2e 只加不减时间）。 */
const BUDGET_MS = Number(process.env.MAP_BUDGET_MS || 20000);
function runAll(ids, label) {
  const t0 = Date.now();
  let bad = 0;
  const rows = [];
  console.log('\n=== ' + label + '（' + ids.length + ' 项）===');
  for (const id of ids) {
    const c = command(id);
    if (!c) { bad++; console.log('✗ ' + id + ' —— 找不到这个判据文件（映射表点名点名不存在的项）'); continue; }
    const t1 = Date.now();
    const r = cp.spawnSync(c.cmd, c.args, { cwd: root, stdio: 'inherit' });
    const ms = Date.now() - t1;
    rows.push({ name: c.name, ms, ok: r.status === 0 });
    if (r.status !== 0) { bad++; console.log('✗ ' + c.name + '（退出码 ' + r.status + ' · ' + ms + ' ms）'); }
    else console.log('✓ ' + c.name + '（' + ms + ' ms）');
  }
  const total = Date.now() - t0;
  console.log(label + '：' + ids.length + ' 项，' + bad + ' 项未通过（' + total + ' ms）');
  console.log('  耗时清单（降序）：' + rows.slice().sort((a, b) => b.ms - a.ms)
    .map(r => r.name.replace(/^tests\//, '') + ' ' + r.ms + 'ms' + (r.ok ? '' : '✗')).join(' ｜ '));
  if (total > BUDGET_MS) {
    const slowest = rows.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log('  ⚠ 超过预算 ' + BUDGET_MS + 'ms（实跑 ' + total + 'ms）。最慢的几条：'
      + slowest.map(r => r.name.replace(/^tests\//, '') + ' ' + r.ms + 'ms').join('、'));
    console.log('  ⚠ 切 `--run --e2e` 之前先看这份清单：e2e 只加不减时间；先收敛上面最慢的几条再决定。');
  }
  return bad;
}

/* ---------- 判据自身：登记表与磁盘、与映射表都要对齐 ---------- */
function selfChecks(reg) {
  const out = [];
  const push = (name, ok, detail) => out.push({ name, ok, detail: detail || '' });
  const disk = diskTests();
  const unregistered = disk.filter(t => !HELPERS[t.id] && !DELEGATED[t.id]
    && !(t.tier === 'browser' ? reg.browser : reg.resident).has(t.id)).map(t => t.file);
  push('每个判据文件都登记在 tests/all.cjs 里（写好了没登记 = 从来没跑过）',
    unregistered.length === 0, unregistered.join(' ; '));
  const diskIds = new Set(disk.map(t => t.id));
  const phantom = [...reg.resident, ...reg.browser].filter(id => !diskIds.has(id));
  push('all.cjs 登记的判据文件都在磁盘上（改名/删掉要一起改 all.cjs）', phantom.length === 0, phantom.join(' ; '));
  const missing = new Set();
  for (const r of ROWS) {
    for (const id of [...r.resident, ...r.browser]) {
      if (id === 'build-check') continue;
      if (!fileOf(id)) missing.add(r.key + ' → ' + id);
      else if (!reg.resident.has(id) && !reg.browser.has(id) && !DELEGATED[id]) missing.add(r.key + ' → ' + id + '（没登记）');
    }
  }
  push('映射表点名的每一项都真实存在且登记过', missing.size === 0, [...missing].join(' ; '));
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const has = f => argv.includes(f);
  const reg = registry();
  if (has('--list')) {
    console.log('映射表');
    for (const r of ROWS) {
      console.log('  ' + r.key);
      console.log('    常驻 ' + (r.resident.join(', ') || '（无）') + ' ｜ 浏览器 ' + (r.browser.join(', ') || '（无）'));
      console.log('    ' + r.why);
    }
    console.log('\n登记表（从 tests/all.cjs 现读）：常驻 ' + reg.resident.size + ' 项 · 浏览器 ' + reg.browser.size + ' 项');
    console.log('不常驻的共用件/探针：' + Object.entries(HELPERS).map(([k, v]) => k + '（' + v + '）').join('、'));
    console.log('由别人代跑的判据：' + Object.entries(DELEGATED).map(([k, v]) => k + '（' + v + '）').join('、'));
  }
  let all = [];
  const fi = argv.indexOf('--files');
  if (fi >= 0) all = argv.slice(fi + 1).filter(x => !x.startsWith('--')).map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''));
  else if (has('--changed') || has('--auto')) {
    const g = gitChanged();
    if (g.error) { console.error('✗ ' + g.error); return 1; }
    all = g.files.filter(f => !f.startsWith('node_modules/'));
    console.log('改动来源：' + g.from + '（' + all.length + ' 个文件）');
  } else if (!has('--list')) {
    console.log('用法：node tests/map.cjs --changed [--run] [--e2e] | --files <文件…> | --list');
    return 0;
  }
  let bad = 0;
  for (const c of selfChecks(reg)) {
    console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + (c.ok || !c.detail ? '' : ' —— ' + c.detail));
    if (!c.ok) bad++;
  }
  /* 三分：已经不在磁盘上的（删掉的旧文件不映射）、不动判据的（文档 / 启动器 / 配置）、真正要映射的源码。 */
  const SOURCE_EXT = /\.(js|mjs|cjs|html|css)$/;
  const gone = all.filter(f => !fs.existsSync(abs(f)));
  const live = all.filter(f => fs.existsSync(abs(f)));
  const docs = live.filter(f => !SOURCE_EXT.test(f));
  const files = live.filter(f => SOURCE_EXT.test(f));
  if (gone.length) console.log('\n已删除（不映射，落空的旧路径）：' + gone.length + ' 个');
  if (docs.length) console.log('不牵动判据（文档 / 启动器 / 配置）：' + docs.join(', '));
  if (!files.length) {
    console.log('\n没有需要映射的源码改动（工作区干净，或只剩文档与删除）');
    return bad ? 1 : 0;
  }
  const p = plan(files);
  console.log('\n改动 → 必跑');
  const unmapped = [];
  for (const row of p.byFile) {
    if (!row.rows.length && !row.derived.length) { unmapped.push(row.file); continue; }
    console.log('  ' + row.file);
    if (row.rows.length) console.log('    表：' + row.rows.join(' ｜ '));
    if (row.derived.length) console.log('    反查：' + row.derived.join(', '));
  }
  if (unmapped.length) console.log('  （以下文件没有命中映射表，按文档表补一行）\n    ' + unmapped.join('\n    '));
  console.log('\n快（常驻判据，无需浏览器）：' + (p.picked.length ? p.picked.join(', ') : '（无）'));
  console.log('慢（浏览器 e2e）：' + (p.browserPicked.length ? p.browserPicked.join(', ') : '（无）'));
  /* 样式改动要把页名带到 ui-visual 上：改一个页面的 CSS 不必把 12 档 × 2 尺寸 × 2 主题全拍一遍。 */
  if (p.browserPicked.includes('ui-visual')) {
    const pages = [...new Set(files.filter(f => f.startsWith('web/styles/spa-')).map(f => f.replace(/^web\/styles\/spa-/, '').replace(/\.css$/, '')))];
    console.log(pages.length
      ? '   ui-visual 只拍点名的这几页：node tests/e2e/ui-visual.cjs --pages=' + pages.join(',')
      : '   改的是 tokens.css / ui.css：全站画面都要重拍，node tests/e2e/ui-visual.cjs');
  }
  if (has('--run')) {
    bad += runAll(p.picked, '快 · 常驻');
    if (has('--e2e')) bad += runAll(p.browserPicked, '慢 · 浏览器');
    else if (p.browserPicked.length) console.log('\nℹ 浏览器判据没跑（test:fast 的预算不含它们）：' + p.browserPicked.join(', ')
      + '\n   要跑：node tests/map.cjs --changed --run --e2e');
  }
  console.log('\n' + (bad ? '✗ ' + bad + ' 项未通过' : '✓ 映射与判据登记表一致' + (has('--run') ? '，所选判据全绿' : '')));
  return bad ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { ROWS, registry, diskTests, plan, selfChecks, HELPERS, DELEGATED, fileOf, resolveNode, BUDGET_MS };
