#!/usr/bin/env node
/* 公共 UI 目录判据：页面只从 web/ui/index.js 取组件；已迁组件带 meta。
   U1..U4：AGENTS.md §3.4 的组件复用硬约束 + §7 的唯一实现清单
   点名的那些**公共面**（`window.Dropdowns` / `window.Toast` / `window.Confirm` / `window.Wb` …）
   以前一条都没被验过 —— 文档写「必须走公共件」，代码里连「这个面存不存在、挂在哪个文件、
   有没有人真的在用」都没人查，所以页面里抄第二份卡片/下拉从来不会红。
     U1 面在代码里真有定义（文档说有、代码里没有 = 假目录，红）
     U2 定义处的层与文档登记的层一致（面挂错层 = 矩阵被破）
     U3 定义处就在文档写的那个文件（§2/§7 的落点，搬家要连着改文档与这条表）
     U4 每个面在**定义文件之外**至少有一个使用点（0 使用 = 大家在各自抄，目录是摆设）
     U5 使用点的跨层方向合规 —— 层矩阵与例外表就是 architecture.cjs 用的那一份（tests/support.cjs）
   判据自带自检：合成的「ui 读 domain 面」必须被 U5 报出来，「页面读 ui 面」必须不报。 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support.cjs');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let bad = 0, n = 0;
function ok(name, cond, detail) { n++; if (cond) return console.log('  ✓ ' + name); bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }

/* 这一份以前 3.9s，慢点全在「重复求值」——
   usageOf 对 34 个面 × 全部 web 源码逐遍 stripComments(read(f))（三十多遍全文扫描），
   globalFaces / layerViolations 又各自重新读盘再扫。现在每个文件只读一次、只剥一次注释，
   剥过的文本喂回 support.cjs 的注入点（globalFaces / layerViolations 都收 read 注入），
   判据语义一字不动，扫的遍数从 ~38 遍收到 3 遍（剥完再剥是幂等全文扫，仍比读盘便宜）。 */
const rawCache = new Map();
const readOnce = f => {
  if (!rawCache.has(f)) rawCache.set(f, read(f));
  return rawCache.get(f);
};
const strippedCache = new Map();
const strippedOf = f => {
  if (!strippedCache.has(f)) strippedCache.set(f, S.stripComments(readOnce(f)));
  return strippedCache.get(f);
};
/* 合成文件（U6 自检）不在真实清单里：按注入 read 现剥一次就缓存。 */
const injectRead = f => {
  if (!strippedCache.has(f)) strippedCache.set(f, S.stripComments(rawCache.has(f) ? rawCache.get(f) : S.read(f)));
  return strippedCache.get(f);
};

const index = read('web/ui/index.js');
ok('目录导出徽标的唯一实现（badgeOf / badgeHTML）', /badgeOf/.test(index) && /badgeHTML/.test(index));
ok('不再有第二份徽标组件', !fs.existsSync(path.join(root, 'web/ui/local-badge.js')));
const badge = read('web/ui/badge-state.js');
ok('badgeOf 与 badgeHTML 都在这一份', /export function badgeOf/.test(badge) && /export function badgeHTML/.test(badge));
ok('徽标样式类只有 srcbadge 一处拼法', /class="srcbadge \$\{b\.cls\}"/.test(badge));

const pages = fs.readdirSync(path.join(root, 'web/pages')).filter(f => f.endsWith('.js'));
for (const f of pages) {
  const s = read('web/pages/' + f);
  const deep = [...s.matchAll(/from\s+'\.\.\/ui\/([^']+)'/g)].map(m => m[1]).filter(x => x !== 'index.js');
  ok(f + ' 只从 ui/index.js 取组件', deep.length === 0, deep.join(','));
}
const dir = read('web/director/index.js');
ok('导演台入口不深引 ui 组件', !/from\s+'\.\.\/ui\/(?!index\.js)/.test(dir));

/* ============================ U1..U5：公共面的目录与使用点 ============================ */
/* 这张表是 AGENTS.md §3.4「必须走公共件」那张表 + §7「唯一实现清单」里点名的面。
   layer 是文档登记的层；owner 是文档写明的落点（§2 目录结构 + §7 那列写了文件的就照抄，
   没写文件的只要求「有且只有一个定义处」）。why 一句话说的是文档的哪一行给了这条要求。 */
const FACES = [
  { face: 'Dropdowns', layer: 'ui', owner: 'web/ui/ui.js', why: '§7「下拉 / 浮层」的唯一实现就是 ui.js 的 Dropdowns' },
  { face: 'UiDialog', layer: 'ui', owner: 'web/ui/forms.js', why: '§3.4「弹窗 / 二次确认」必须走 UiDialog.open' },
  { face: 'Confirm', layer: 'ui', owner: 'web/ui/forms.js', why: '§3.4「弹窗 / 二次确认」：ask / arm / choose 只有一份' },
  { face: 'Toast', layer: 'ui', owner: 'web/ui/toast.js', why: '§7「提示」唯一实现 web/ui/toast.js 的 Toast' },
  { face: 'Net', layer: 'ui', owner: 'web/ui/net.js', why: '§7「网络」唯一实现（超时 / 重试 / NUMS）' },
  { face: 'Store', layer: 'ui', owner: 'web/ui/store.js', why: '§7「本地存储」唯一实现（信封 / 上限 / sweep）' },
  { face: 'Kv', layer: 'ui', owner: 'web/ui/kv.js', why: '§7「IndexedDB」：登记表只有一份，走 Kv.at' },
  { face: 'DataSync', layer: 'ui', owner: 'web/ui/datasync.js', why: '§7「数据同步」唯一实现' },
  { face: 'WbSkills', layer: 'ui', owner: 'web/ui/skills.js', why: '§7「Skill」面板唯一实现' },
  { face: 'GoPage', layer: 'ui', owner: 'web/ui/ui.js', why: '§3.4「跳页」必须 GoPage.go，站内不再 location.href' },
  { face: 'Wb', layer: 'ui', owner: 'web/ui/workbench.js', why: '§3.4/§7 的任务面：cards / pager / viewToggle / thumbs / lightbox / save / vframe' },
  { face: 'VIEW_MODES', layer: 'ui', owner: 'web/ui/ui.js', why: '§3.4「视图档」：Wb.viewToggle 配的就是这一份模式表' },
  { face: 'Chips', layer: 'ui', owner: 'web/ui/ui.js', why: '§3.4「筛选芯片」：Chips.render 唯一' },
  { face: 'AiChip', layer: 'ui', owner: 'web/ui/ui.js', why: '§3.4「AI 条件芯片」：AiChip.paint 唯一' },
  { face: 'PickSel', layer: 'ui', owner: 'web/ui/ui.js', why: '§3.4「素材选择 / 多选」的多选态' },
  { face: 'InlinePolish', layer: 'ui', owner: 'web/ui/forms.js', why: '§3.4「就地润色」唯一' },
  { face: 'PromptForm', layer: 'ui', owner: 'web/ui/forms.js', why: '§3.4「提示词表单」唯一（正文六句只在 TextAI）' },
  { face: 'PromptReview', layer: 'ui', owner: 'web/ui/forms.js', why: '§6.1-2 表单族：拆分镜的润色审阅面板只有这一份（导演台与工作台共用）' },
  { face: 'DatePicker', layer: 'ui', owner: 'web/ui/forms.js', why: '§6.1-2 表单族：日期选择弹层只有这一份（替换浏览器原生日历）' },
  { face: 'Api', layer: 'domain', owner: 'web/domain/api.js', why: '§3.4/§7「媒体」：mediaSrc / mediaKey / mediaExpired / healMedia 唯一出口' },
  { face: 'AssetLib', layer: 'domain', owner: 'web/domain/assetlib.js', why: '§7「资产」四件之一' },
  { face: 'AssetLocal', layer: 'domain', owner: 'web/domain/local.js', why: '§3.4「本机标识」：徽标判据只在 AssetLocal.stateOf' },
  { face: 'AssetTransfer', layer: 'domain', owner: 'web/domain/asset-transfer.js', why: '§7「资产」四件之一（搬运 / 转存）' },
  { face: 'AssetPicker', layer: 'domain', owner: 'web/domain/asset-picker.js', why: '§3.4「素材选择」必须走 AssetPicker' },
  { face: 'AiFind', layer: 'domain', owner: 'web/domain/ai-find.js', why: '§3.4「AI 挑几条」：AiFind.run 唯一' },
  { face: 'TextAI', layer: 'domain', owner: 'web/domain/text-ai.js', why: '§7「文字 AI」：含 polishImages / qaOf 契约' },
  { face: 'Capabilities', layer: 'domain', owner: 'web/domain/capabilities.js', why: '§7「能力声明」唯一实现' },
  { face: 'PromptLog', layer: 'domain', owner: 'web/domain/prompt-log.js', why: '§7「提示词归档」唯一实现' },
  { face: 'Fav', layer: 'domain', owner: 'web/domain/fav.js', why: '§7「收藏」唯一实现' },
  { face: 'Chars', layer: 'domain', owner: 'web/domain/chars.js', why: '§7「素材库」：Lib / Pipe / SET' },
  { face: 'SemanticSearch', layer: 'domain', owner: 'web/domain/semantic.js', why: '§7「语义检索」：rank 一份，助手与 Ctrl+F 共用' },
  { face: 'CharLimits', layer: 'domain', owner: 'web/domain/gen-forms.js', why: '§7「字数闸」唯一实现' },
  { face: 'TtsAdv', layer: 'domain', owner: 'web/domain/gen-forms.js', why: '§7「配音合成设置」：TtsAdv + AdvExtras' },
];
const faces = S.globalFaces({ read: injectRead });
const webFiles = S.webSources().map(p => S.asRel(p));
const usageOf = name => {
  const d = faces.get(name);
  let users = 0, sites = 0;
  for (const f of webFiles) {
    if (d && d.files.includes(f)) continue;                    // 定义方自己不算使用点
    const c = S.faceReads(strippedOf(f), name);
    if (c) { users++; sites += c; }
  }
  return { users, sites };
};
for (const r of FACES) {
  const d = faces.get(r.face);
  ok(`U1 面 ${r.face} 有定义（${r.why}）`, !!d,
    '代码里找不到 `window.' + r.face + ' =` —— 文档说有、代码里没有');
  if (!d) continue;
  ok(`U2 面 ${r.face} 挂在 ${r.layer} 层（定义处 ${d.files.join(', ')}）`, d.layers.length === 1 && d.layers[0] === r.layer,
    '实际层是 ' + d.layers.join('/') + '；一个面被两处不同层定义 = 同一件公共事有两份实现');
  if (r.owner) ok(`U3 面 ${r.face} 的落点是 ${r.owner}`, d.files.length === 1 && d.files[0] === r.owner,
    '实际定义在 ' + d.files.join(', ') + '（搬家就同时改这张表与 AGENTS.md §7）');
  const u = usageOf(r.face);
  ok(`U4 面 ${r.face} 在定义文件之外有使用点（${u.users} 个文件 / ${u.sites} 处）`, u.users > 0,
    '没人用它 = 页面各自抄了一份，§3.4 的硬约束没落地');
}

/* U5：使用点的跨层方向 —— 与 architecture.cjs 读同一份矩阵与同一张例外表
   （read 注进剥好的一遍文本，判据本身不变）。 */
const layerCurrent = S.layerViolations({ faces, read: injectRead });
const r5 = S.ratchet(layerCurrent, S.LAYER_EXCEPTIONS);
ok(`U5 公共面使用点的分层方向合规（现 ${r5.total} 处 / 登记 ${S.LAYER_EXCEPTIONS.reduce((a, x) => a + x.max, 0)} 处 · ${Object.keys(layerCurrent).length} 组）`,
  r5.grown.length === 0, r5.grown.map(x => x.id + ' = ' + x.n + (x.max != null ? '（上限 ' + x.max + '）' : '（没登记）')).join(' ; '));
for (const x of r5.grown) console.log('    ✗ ' + x.id + '：' + x.why);

/* 自检：探测器对合成违例没反应 = 这几条 U 是装饰 */
const SYNTH = 'web/ui/__synthetic_probe.js';
const hit = S.layerViolations({ faces, files: [SYNTH], read: () => `window.__Synthetic = { go() { return Api.request('/x'); } };` });
ok('U6 自检：合成 `ui → domain` 读点必须被报出来、页面读 ui 面不许报',
  Object.keys(hit).some(k => k === SYNTH + ' → Api [domain]')
  && !Object.keys(S.layerViolations({ faces, files: ['web/pages/__synthetic_ok.js'], read: () => `window.__SyntheticOk = { go() { return Dropdowns.sync(el); } };` })).length,
  '合成违例 ' + Object.keys(hit).join(' ; ') + '（或正确写法被误报）');

/* U7 分页行的 id 必须与 `Wb.pager.rowHTML(前缀)` 对上。
   七页同在 KeepAlive 里，同一个文档里同时存在七套分页行 —— 写死 `pgPrev` 就是撞号。
   更隐蔽的坏法是前缀传成 `charsPg`（生成 `charsPgPgPrev`）而 create 找 `charsPgPrev`：
   按钮绑定不上、翻页文案永远停在第一页，页面上没有任何报错。 */
const pagerBad = [];
for (const p of webFiles) {
  const s = readOnce(p);
  for (const m of s.matchAll(/\.rowHTML\(\s*'([A-Za-z0-9_]+)'/g)) {
    const pre = m[1];
    const want = { pgPrevId: pre + 'PgPrev', pgInfoId: pre + 'PgInfo', pgNextId: pre + 'PgNext' };
    const miss = Object.entries(want).filter(([k, id]) => !new RegExp(k + ":\\s*'" + id + "'").test(s));
    if (miss.length) pagerBad.push(p + ' rowHTML(\'' + pre + '\') 缺 ' + miss.map(([k, id]) => k + ": '" + id + "'").join(' / '));
  }
}
ok('U7 分页行 id 与 rowHTML 前缀一致（统一 id）', pagerBad.length === 0, pagerBad.join(' ; '));

console.log(`\n${n} 项，${bad} 项未通过`);
process.exit(bad ? 1 : 0);
