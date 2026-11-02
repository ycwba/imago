#!/usr/bin/env node
/* 源码行数 / 字节基线 —— 跑法：`node tests/metrics.cjs [--write|--strict]`
   统计源码（.js/.html/.css），排除 Vue vendor、tests、docs、备份与用户数据。
   codeLines = 去掉空行与注释后的行数；vendor 单列。
   默认只**打印**（本地要知道自己长胖了多少）；`--strict` 把三件事变成会红的判据（`tests/all.cjs` 固定带这一档）：
     M1 基线文件在且能读 —— 基线丢了，「不超基线 5%」这句就成了空话，必须红
     M2 总行数 / 代码行不超过基线 +5%（以前这条永远绿，因为没人拿它判红）
     M3 单文件 >1500 行的必须逐条登记上限（只许减不许增）；
        `web/director/engine.js` 的登记理由是已决定的取舍（「engine.js 仍是大文件，『单文件 < 3k』不适用于它」）—— 是**登记**，不是豁免：
        它涨一行也红，收敛一行就该把 max 调小。
   `--write` 重打基线（收敛之后或结构搬家用它，别为了让判据绿而写）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support.cjs');

const root = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');
const STRICT = process.argv.includes('--strict');
const BASE = path.join(__dirname, 'metrics-baseline.json');
const LINE_LIMIT = 1500;          // 「单文件行数」判据线
const GROWTH_PCT = 5;             // 「总量相对基线」判据线
/* `design/` 曾经是设计提案目录（静态预览稿，不被 shell.html / web/ 引用、不进构建、
   不进运行时），和 docs / tools 同一类 —— 拿它算源码体积只会把判据线越推越松。
   目录已删，但排除项留着：以后再放设计稿进来时，判据线不该被它顶松。 */
const EXCLUDE_DIRS = new Set(['tests', 'docs', '_backup', '.git', 'node_modules', 'prompts', '文件', '.shots', '.data', '.assets', '.renders', 'render', 'tools', 'design']);
/* vendored 第三方（本地带上、运行时零构建）：压过的产物不是我们的代码，不参与行数判据 */
const EXCLUDE_FILES = new Set(['vue.runtime.esm-browser.prod.js', 'mediabunny-aac-encoder.min.js']);
const EXTS = new Set(['.js', '.html', '.css']);

/* 超大文件登记表（只许减不许增，理由与 static-guards 的表同一套语义）：
   「一个文件 1500 行」这条以前只是文档里的一句话，所以谁都能再往下写。
   每张卡都有一句话说明为什么今天还留着、以及要往哪儿收 —— 写不出原因的就不该登记，该拆。 */
const BIG_FILES = [
  { file: 'web/director/engine.js', max: 4600, why: '已决定：剪辑交互与预览引擎保持命令式，engine.js 是全站最大文件（「单文件 < 3k」不适用于它）。热路径按域搬在 web/director/engine/<域>.js，这一份只留工程数据、可变状态与接线；2026-11-02 这一批 +29 是关键帧那一排拆分选项的三个模块变量与它的落盘 —— 值必须存这一层（右栏每 3 秒整片重画，域模块里不留第二份可变状态）；再涨一行要说明为什么不能进已有域模块' },
  { file: 'web/pages/settings.js', max: 4017, why: '账号卡流已搬进 web/pages/settings/accounts.js。这一页剩下 15 张卡的其余部分：SET_ROWS 那一份声明式清单与它的渲染 / 写盘、外观 / 存放 / 素材库 / 助手 / 网络各档的控件、云同步、Skill 场景、目录轨与滚动出口。再涨先问哪一块能像账号卡那样搬成页面自己的子模块（先例：chars/detail.js、settings/accounts.js）' },
  { file: 'web/features/chat.js', max: 3701, why: '助手的外壳 / 会话 / 渲染 / 发送循环（工具循环与动作目录在 chat-tools.js）。再涨就先把会话存储与发送循环拆开' },
  { file: 'web/pages/studio.js', max: 3730, why: '工作台页面侧装配：卡片界面在 ui/workbench，这里剩表单与生成流程。2026-11-02 这一批 +164 是两栏之间的两颗「送过去」（视频栏提示词 → 图像栏那一格 / 图片产物 → 视频栏参考素材）与它那串能力闸，含「送进参考槽的地址取 media 不取 raw」那一条写明；再涨就把三种类型的表单各自成块（先例：chars/detail.js、settings/accounts.js）' },
  { file: 'web/ui/workbench.js', max: 3433, why: '工作台那十几个公共 namespace（卡片 / 分页 / 视口 / 筛选条 / 文件类型档 / 分栏 / 灯箱 / 缩略图 / 批量下载 / 历史 / 详情），三页共用所以留在公共层。收它是把它按 namespace 切成几份，不是退回页面；+73 是两件共用件的唯一实现：状态牌 `plateHTML`（资产库与工作台的任务占位同一套，以前各画一套）与 `fullBtnHTML`（预览图右下角的全屏观看按钮），另加详情里的「进度」实时刷新（`_liveProgress`，只有公共灯箱/详情这一层知道怎么向平台回源）' },
  { file: 'web/domain/chars.js', max: 2458, why: '素材库域（Lib / Pipe / SET）：界面那一半要挪回页面，数据与流程留在这一份；+7 是三视图资产模板改成「左正面肖像 / 右三视图、纯白底、固定 16:9」那一句与它为什么写死在模板里的注释（分区是后续参考图的判据，交给文字 AI 自由发挥就不稳）' },
  { file: 'web/director/engine/panel.js', max: 2268, why: '导演台右栏（剪辑/生成/字幕/台词四档 + 弹层接线），从 engine.js 整块搬出。2026-11-02 这一批 +29 是关键帧那一排拆分选项的宿主与接线（画交公共件 SplitPlan，值存 engine 那一层）；要收就把每一档的字段与参数表单拆成一张表，按表渲染' },
  { file: 'web/features/chat-tools.js', max: 2218, why: '助手的工具循环与动作目录（TOOLS / ACTS / TOOL_INPUT / ACTION_META 四张表与注册装配）。再拆就按「生成 / 素材 / 时间线」把动作各自成表；两张形状表只能有一份' },
  { file: 'web/domain/api.js', max: 1922, why: '取数层：Api + 媒体地址 / 状态归类 / 发送前预览（buildBody·preview 与 create 同源）/ exportCaps。再拆就把「媒体地址」单独切一块 —— workbench 也读它，切完两处仍要同一入口；+4 是 parseItem 收「详情端点的对象形产物」（outputs:[{asset_id}]），只认列表那种 id 串数组会让走详情的轮询永远拿不到产物号' },
  { file: 'web/director/engine/edit.js', max: 1707, why: '导演台板上交互（点选 / 六档工具 / 拖把手 / 换序 / 吸附 / 波纹 / 标记 / 右键菜单）与写 film 的唯一出口 commit·patchFilm。再拆会把「写 film 只有一个出口」这一条分进两份文件，那正是这条规则要防的事' },
  { file: 'web/ui/forms.js', max: 1700, why: '弹窗与表单族（就地润色 / 润色审阅 / 页内确认 / UiDialog / DatePicker / PromptForm / SplitPlan），是从 ui.js 分出来的那一族。Confirm 与 UiDialog 只能有一份实现，所以能切的只有润色与 PromptForm 两块；2026-11-02 这一批 +106 是 SplitPlan（两家共用的那一排拆分选项与那两行话术）—— 它读家是 ESM 页面与命令式岛各一个，只有 window 面同时够得到两边，另起一枚脚本要多吃一次首屏字节' },
  { file: 'web/ui/ui.js', max: 1590, why: '跨页共用的面（下拉 / 芯片 / 多选 / 格式 / 视图档 / 界面偏好 UI_PREFS / 侧栏余额）。再涨先问这一枚是不是只有一两页在用 —— 是就回页面，不是新公共件' },
  { file: 'web/pages/chars.js', max: 1587, why: '素材页：整屏编辑层已在 web/pages/chars/detail.js，默认值在设置页那张卡。再涨就把批量动作那一族搬进 detail.js 那一层' },
  { file: 'web/pages/assets.js', max: 1508, why: '资产库页：卡片网格 + 详情层 + 筛选 + 批量条。列表 / 翻页 / 多选 / 灯箱 / 展开锚定都在公共件里，这一页只余排布与取数接线；再涨先问哪一块其实是公共件' },
  { file: 'server/registry-config.js', max: 1503, why: '供应商注册表 REGISTRY 与两份本机覆盖。1503 行里只有 857 行是代码，余下都是 providers / endpoints / 能力声明的数据字面量；「新平台只改这一处」是硬约定，按家切成多份就让同一族声明有了多个落点。要收只能收数据的重复段，不是拆文件' },
];

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
/* 探测器自检：判据自己不验证自己，就会退化成永远绿 —— 合成一份「胖了 20% 的基线」和
   「一个没登记的超大文件」，报不出来就是这条判据坏了。 */
function selfCheck() {
  const probs = [];
  if (!overPct(106, 100, GROWTH_PCT)) probs.push('总量判据对「+6%」没反应');
  if (overPct(104, 100, GROWTH_PCT)) probs.push('总量判据把「+4%」也报红（阈值算错）');
  const synth = bigFilesOver([{ file: 'web/pages/zz-synthetic.js', lines: LINE_LIMIT + 1 }]);
  const r = S.ratchet(synth, BIG_FILES, { kind: 'counts' });
  if (!r.grown.length) probs.push('超大文件判据对合成违例没反应');
  const r2 = S.ratchet({ 'web/director/engine.js': 999999 }, BIG_FILES, { kind: 'counts' });
  if (!r2.grown.length) probs.push('engine.js 的白名单是无条件的（登记上限没起作用）');
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

  const over = bigFilesOver(cur.files);
  const r = S.ratchet(over, BIG_FILES, { kind: 'counts' });
  const registered = BIG_FILES.reduce((a, x) => a + x.max, 0);
  ok(`M3 超过 ${LINE_LIMIT} 行的文件都登记且没增长（现 ${r.total} 行 / 登记 ${registered} 行 · ${Object.keys(over).length} 个文件）`,
    r.grown.length === 0,
    r.grown.map(x => x.id + ' = ' + x.n + (x.max != null ? '（登记 ' + x.max + '）' : '（没登记）')).join(' ; '));
  for (const x of r.stale.slice(0, 6)) {
    const now = over[x.id] || 0;
    console.log('    ℹ 可以收紧：' + x.id + ' 现在 ' + now + ' 行，登记 ' + x.max);
  }
  const probs = selfCheck();
  ok('判据自检（合成「胖了 20%」与「没登记的超大文件」必须被报出来）', probs.length === 0, probs.join(' ; '));
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
  console.log('\n超过 ' + LINE_LIMIT + ' 行的文件：' + Object.keys(over).length + ' 个（本地不加参数只打印；`npm run test` 恒定带 `--strict`，那一档才是判红的那一档）');
}
process.exit(bad ? 1 : 0);
