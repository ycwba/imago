#!/usr/bin/env node
/* 设置键一张账（报告 §6.2「设置键有 5 份清单，已出现漂移」）—— 跑法：node tests/settings-schema.cjs
   报告点名的漂移是真的：设置页 `saveAllNow` 存了 `ai_chat_off/auto/snap/notice`，而导出的那份
   `EXPORTABLE` 里没有 notice/snap —— 换机器导一次设置，助手卡片上那几颗开关全回到默认档；
   同一类漏在同步那一侧是 `sb_open` 与 `sk_media_badge`（界面偏好表里有，SYNCABLE 手抄的那份没有）。

   收法按「最靠近数据的那一层」：**界面偏好有哪几项**只由 ui.js 的 `UI_PREFS` 决定，
   三份清单（跟着 .data 走 / 进设置导出 / 恢复默认不清）都从那张表现取，不再各自抄一遍字面量。
   这里判六件事：
     ① 三张名单都真的接在 UI_PREFS 上（结构判据：少了接线 = 那张表又变成第三份手抄）；
     ② UI_PREFS 的键名**不许**再以字面量出现在任何一张名单里（出现了就是两份出处，会漂）；
     ③ `keep` 那一列与「恢复默认不清」的实际效果一致；
     ④ 设置页写下去的每一个键都能被导出名单认出来（前缀算认出来）—— 新加一项设置没登记就在这里红；
     ⑤ 助手开关那几条的口径：进导出、不进云同步、只有「关掉助手」这一条恢复默认不清；
     ⑥ shell.html 的加载顺序里 ui.js 在 datasync.js 之前（否则 PREF_KEYS 取到空表，那一批静默不同步）。
   云同步与「恢复默认」都是会动用户数据的路径，所以这一节只做只读判据，不真去 sweep 或发请求。 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, total = 0;
const ok = (name, cond, hint) => {
  total++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && hint ? ' —— ' + hint : ''));
  if (!cond) fails++;
};
console.log('§ 设置键一张账（UI_PREFS 派生 · 只读判据）');

/* ---------- UI_PREFS：键名与 keep 列（从源码取，不在 Node 里求值整份 ui.js） ---------- */
const ui = read('web/ui/ui.js');
const upStart = ui.indexOf('window.UI_PREFS = {');
const upSlice = upStart >= 0 ? ui.slice(upStart, ui.indexOf('  keys()', upStart)) : '';
const rowAt = [];
upSlice.replace(/key: '([A-Za-z0-9_]+)'/g, (m, k, off) => { rowAt.push([k, off]); return m; });
const rows = {};
rowAt.forEach(([k, off], i) => {
  const stop = i + 1 < rowAt.length ? rowAt[i + 1][1] : upSlice.length;
  rows[k] = /keep:\s*1/.test(upSlice.slice(off, stop));
});
const prefKeys = Object.keys(rows);
ok('UI_PREFS 有行可取（' + prefKeys.length + ' 项）', prefKeys.length >= 8, prefKeys.join(','));
const keepKeys = prefKeys.filter(k => rows[k]);

/* ---------- ① 三张名单都接在表上 ---------- */
const ds = read('web/ui/datasync.js');
const st = read('web/pages/settings.js');
ok('DataSync 的同步名单取 UI_PREFS（不是再抄一份）',
  /PREF_KEYS = \(window\.UI_PREFS && window\.UI_PREFS\.keys\)[^\n]*keys\(\)/.test(ds)
  && /\.\.\.PREF_KEYS,/.test(ds.slice(ds.indexOf('const SYNCABLE'), ds.indexOf('const NOT_SYNC'))),
  'PREF_KEYS 没接 UI_PREFS.keys()，或没进 SYNCABLE 数组');
const arrOf = (src, name) => {
  const i = src.indexOf('const ' + name + ' = [');
  if (i < 0) return '';
  return src.slice(i, src.indexOf('];', i));
};
const exportArr = arrOf(st, 'EXPORTABLE'), keepArr = arrOf(st, 'RESET_KEEP');
ok('设置页导出名单取 UI_PREFS', /\.\.\.\(\(window\.UI_PREFS && window\.UI_PREFS\.keys\)/.test(exportArr), exportArr.slice(-120));
ok('「恢复默认不清」取 UI_PREFS 的 keep 列', /keepKeys\(\)/.test(keepArr), keepArr.slice(-120));

/* ---------- ② 表里的键名不许再当字面量出现在名单里 ---------- */
/* 数组字面量里的键名：先把注释摘掉（那些散文里也带引号，不摘就成了「名单里有的一条键」）。 */
const stripCmts = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const literals = a => [...stripCmts(a).matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
const handCopied = [
  ['SYNCABLE', literals(arrOf(ds, 'SYNCABLE'))],
  ['EXPORTABLE', literals(exportArr)],
  ['RESET_KEEP', literals(keepArr)],
].flatMap(([n, list]) => list.filter(k => prefKeys.includes(k)).map(k => n + ':' + k));
ok('界面偏好的键名没有在名单里再抄一遍', handCopied.length === 0, handCopied.join(', '));

/* ---------- ③ keep 列 = 恢复默认不清的那一批 ---------- */
const wantKeep = ['dir_theme', 'sb_open', 'dir_asset_view', 'dir_char_view', 'dir_fav_view',
  'sk_media_local', 'sk_media_prefer', 'sk_media_badge', 'sk_media_cloud_hide'];
ok('keep 列点名「主题 / 视图档位 / 产物开关」', wantKeep.every(k => rows[k] === true) && keepKeys.length === wantKeep.length,
  'keep=' + keepKeys.join(',') + '（应当恰好是 ' + wantKeep.length + ' 项）');
ok('安静档与停靠/吸边这类纯显示项可以被恢复默认清掉', rows.sk_quiet_ok === false, 'sk_quiet_ok 被标了 keep');

/* ---------- ④⑤ 设置页写下去的每个键都要被导出认出来 ---------- */
const covers = (list, k) => list.some(p => k === p || k.startsWith(p));
const written = new Set();
for (const m of st.matchAll(/\bWdel?\('([A-Za-z0-9_]+)'/g)) written.add(m[1]);
for (const m of st.matchAll(/localStorage\.setItem\('([A-Za-z0-9_]+)'/g)) written.add(m[1]);
/* 下划线开头的是「写完立刻删掉」的探针（_probe_write：探这台浏览器还能不能存东西），不是设置项。 */
[...written].filter(k => /^_/.test(k)).forEach(k => written.delete(k));
written.add('sk_media_local_scope');                       // 第三档依附开关：由 1907 行那条 setItem 写
prefKeys.forEach(k => written.add(k));                     // UI_PREFS 那一圈由 saveUiPrefs 循环写
const notExported = [...written].filter(k => !covers(literals(exportArr).concat(prefKeys), k));
ok('设置页写的每一项都在导出名单里（新加一项必须登记）', notExported.length === 0, '漏：' + notExported.join(', '));
const ASSIST = ['ai_chat_auto', 'ai_chat_off', 'ai_chat_snap', 'ai_chat_notice', 'ai_chat_dock'];
const EX = literals(exportArr);
ok('助手那五颗开关进导出（报告点名的 notice/snap 漂移）', ASSIST.every(k => EX.includes(k)),
  ASSIST.filter(k => !EX.includes(k)).join(','));
ok('对话记录与附件/坐标/进度不跟着导出走（不写 ai_chat_ 前缀）',
  !EX.includes('ai_chat_') && !EX.includes('ai_chat') && !EX.includes('ai_chat_files') && !EX.includes('ai_chat_xy'),
  EX.filter(k => k.startsWith('ai_chat')).join(','));
const dsn = literals(arrOf(ds, 'NOT_SYNC'));
ok('助手开关仍是本机的事：不进云同步那条前缀',
  ASSIST.filter(k => k !== 'ai_chat_dock').every(k => dsn.includes(k)),
  ASSIST.filter(k => !dsn.includes(k)).join(','));
const syncedPref = k => !dsn.some(x => k === x || k.endsWith(x) || k.startsWith(x));
const inSyncArr = literals(arrOf(ds, 'SYNCABLE'));
const syncOf = k => covers(inSyncArr.concat(prefKeys), k) && syncedPref(k);
ok('每一项界面偏好都跟着 .data 走（含 sb_open / sk_media_badge）',
  prefKeys.every(syncOf), prefKeys.filter(k => !syncOf(k)).join(','));
ok('「关掉助手」这一条恢复默认也不清', literals(keepArr).includes('ai_chat_off'),
  'RESET_KEEP 里没有 ai_chat_off：一次「恢复默认」会把那颗悬浮球重新装回来');

/* ---------- ⑥ 加载顺序：datasync.js 取 PREF_KEYS 时 ui.js 必须已经求值完 ----------
   2026-10-21 G2 之后 datasync.js 不在 shell.html 里常驻了：它由路由表的 `needs` 在页面组件
   `import()` 之前补载（web/core/routes.js 声明、web/app.js 发）。挂法变了，要守的东西没变 ——
   UI_PREFS 是 ui.js 求值时才挂上 window 的，datasync.js 在求值期现取那张表，早一步就取到空表，
   那一批界面偏好会静默不同步。两种挂法都验同一件事。 */
const shell = read('shell.html');
const order = [...shell.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
const iUi = order.findIndex(s => s.endsWith('web/ui/ui.js'));
const iDs = order.findIndex(s => s.endsWith('web/ui/datasync.js'));
const lazyDs = iDs < 0
  && /web\/ui\/datasync\.js/.test(read('web/core/routes.js'))
  && /__spaNeeds\([^)]*\)\s*\.then\s*\(/.test(read('web/app.js'));
ok('ui.js 先于 datasync.js 求值（壳里排在前面，或 datasync 走路由 needs 在页面组件之前补载）',
  iUi >= 0 && (iDs > iUi || lazyDs),
  'ui.js=' + iUi + ' datasync.js=' + iDs + ' 按页补载=' + lazyDs);

console.log((fails ? '✗ ' : '✓ ') + total + ' 项，' + fails + ' 项未通过');
process.exit(fails ? 1 : 0);
