#!/usr/bin/env node
/* 源码行数 / 字节基线 —— 跑法：`node tests/metrics.cjs [--write|--strict]`
   统计源码（.js/.html/.css），排除 Vue vendor、tests、docs、备份与用户数据。
   codeLines = 去掉空行与注释后的行数；vendor 单列。
   默认只**打印**（本地要知道自己长胖了多少）；`--strict` 把三件事变成会红的判据（CI 用）：
     M1 基线文件在且能读 —— 基线丢了，「不超基线 5%」这句就成了空话，必须红
     M2 总行数 / 代码行不超过基线 +5%（以前这条永远绿，因为没人拿它判红）
     M3 单文件 >1500 行的必须逐条登记上限（只许减不许增）；
        `web/director/engine.js` 的登记理由就是 AGENTS.md §17 那条已决定的取舍
        （「engine.js 仍是大文件，『单文件 < 3k』不适用于它」）—— 是**登记**，不是豁免：
        它涨一行也红，收敛一行就该把 max 调小。
   `--write` 重打基线（收敛之后或结构搬家用它，别为了让 CI 绿而写）。 */
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
/* `design/` 是设计提案目录（design/preview/SPEC.md 自述：四版静态预览稿，不被 shell.html / web/ 引用、
   不进构建、不进运行时），和 docs / tools 同一类 —— 拿它算源码体积只会把判据线越推越松。 */
const EXCLUDE_DIRS = new Set(['tests', 'docs', '_backup', '.git', 'node_modules', 'prompts', '文件', '.shots', '.data', '.assets', '.renders', 'render', 'tools', 'design']);
/* vendored 第三方（本地带上、运行时零构建）：压过的产物不是我们的代码，不参与行数判据 */
const EXCLUDE_FILES = new Set(['vue.runtime.esm-browser.prod.js', 'mediabunny-aac-encoder.min.js']);
const EXTS = new Set(['.js', '.html', '.css']);

/* 超大文件登记表（只许减不许增，理由与 static-guards 的表同一套语义）：
   「一个文件 1500 行」这条以前只是文档里的一句话，所以谁都能再往下写。
   每张卡都有一句话说明为什么今天还留着、以及要往哪儿收 —— 写不出原因的就不该登记，该拆。 */
const BIG_FILES = [
  { file: 'web/director/engine.js', max: 5389, why: 'AGENTS.md §17 已决定：剪辑交互与预览引擎保持命令式，engine.js 是全站最大文件（「单文件 < 3k」不适用于它）。十一块热路径已按域搬到 web/director/engine/<域>.js，这里只剩状态、接线与 DOM 装配；5389 是画面格三段式、图片段、字幕 ASR 与拖素材进轨这几处接到 engine 之后的实测，再涨一行要说明为什么不能进已有域模块' },
  { file: 'web/director/engine/panel.js', max: 2116, why: '从 engine.js 整块搬出的右栏（剪辑/生成/字幕/台词四档 + 弹层接线），搬时不改逻辑，所以体积原样保留；2116 是音色档与字幕精确起止加进来之后。要收就得把每一档拆成一张表' },
  { file: 'web/director/engine/track.js', max: 1938, why: '从 engine.js 搬出的轨道渲染与拖动（候选条 / 两条待生成轨 / 把手拖动外壳）。1938 行里含把手拖动那份（本镜与全片两排字幕也共用同一套手势）与待生成轨自己那套拖影；dup-guard 登记的另两份（chat.js / workbench.js）向它收敛之后这里也该跟着薄' },
  { file: 'web/director/engine/lanes.js', max: 1512, why: '时间轴比例尺（pxPerSec）、刻度、缩放与两排轨道渲染都在这一份，三段式画面格（名称行 + 切片 + 原声波纹带）也落在它里面。刚过 1500 线：再涨先想清楚这一段是不是属于「渲染」而不是「几何」' },
  { file: 'web/features/chat.js', max: 3817, why: '曾经的巨型闭包之一（助手）：工具循环与动作目录已拆去 chat-tools.js，这里只剩外壳 / 会话 / 渲染 / 发送循环；3817 是球旁浮窗、拖素材引用队列与只读工具接线之后。再涨就先把会话存储与发送循环拆开' },
  { file: 'web/features/chat-tools.js', max: 2208, why: '从 chat.js 拆出的工具循环与动作目录（TOOLS / ACTS / 形状表 / 注册表装配）；2208 是画布动作整族删除之后的实测，含 task_detail / asset_open / export_list 几条只读工具与两张形状表。再拆就按「生成 / 素材 / 时间线」各自成表' },
  { file: 'web/domain/api.js', max: 1893, why: '按 window 面拆开的取数层：Api + 媒体地址/状态归类/统一取数的顶层函数。1893 是「发送前的请求预览」（buildBody / preview，与 create 同源）与 exportCaps（成片环境现探）落在这一层、「按类型另存」那几条撤走之后；再拆就把「媒体地址」单独切一块（workbench 也读它）' },
  { file: 'web/pages/settings.js', max: 4673, why: '每个供应商的面板都写在一个页面文件里（型号表拆开后这里也该跟着薄）。4673 是「供应商与密钥」改成账号卡流（设计稿 design/provider-matrix：「按 keyId 归并的账号卡 + 能力格 / 能力行 / 就地展开的型号面板 / 等高中段自滚 / 添加卡与自定义表单搬位」，同时删掉整排类型分段开关与它那一套过滤）之后的实测；普通设置行的重复字段收成 SET_ROWS 一行一条，组名单也不再手抄（读模板里那一节标题）。这块**已经到该搬的时候**：下一个改这一页的动作要先把「供应商与密钥」那张卡（provGroups 起到 placeForms 止）搬成自己的子模块，搬完把这一行调下去' },
  { file: 'web/pages/studio.js', max: 3199, why: '曾经的巨型闭包之三（工作台页面侧装配）：卡片界面已挪到 ui/workbench，剩下的表单与生成流程待拆。3177 → 3199 是图片卡上「加到时间线」那一枚（跨页只递一次，导演台取走即删）接进来之后的实测；再涨就把三种类型的表单各自成块' },
  { file: 'web/ui/workbench.js', max: 2717, why: '工作台卡片/灯箱/批量条：与 assetlib 同批收敛；卡片动作条与重试锁收敛在此。2786 → 2717 是取帧那一路收成 window.MediaBackend 的转发壳（`<video>` 只在媒体后端那一份里创建）之后；只许往下走' },
  { file: 'web/domain/chars.js', max: 2368, why: '角色域：拆 Chars 时要把界面挪回页面；2368 是在 2347 之后给 SET 表补上「默认生图型号 / 默认语音型号 / 默认一次出几条语音」三项（素材页的默认值改由设置页那张卡管，语音条数与出图张数分成两项）之后的实测' },
  { file: 'web/domain/local.js', max: 1554, why: '本机资产镜像层（AssetLocal）：镜像索引、本机↔外链回退、媒体错误兜底（「已丢失」角标）与跨标签页同步都在这一份。1554 是给角标补上「只盖自己那一格、绝不铺满整屏」的定位之后；再涨先把索引的读写拆出去' },
  { file: 'web/pages/chars.js', max: 1718, why: '角色页：与上一份是同一个域的两半，收敛时一起薄一半；1718 是「新建 / 编辑一条素材」整屏层（web/pages/chars/detail.js）与目录轨搬出去之后，又把左轨那块「本页默认」拆成「设置页默认值 + 两处现场挑型号」（目录轨「出齐用」一行、多选批量条上的出图/声音两行）、并接上「能力一家落定就补画型号下拉」之后的实测；再涨就把批量动作那一族搬进 detail.js 那一层' },
  { file: 'web/ui/ui.js', max: 1502, why: '公共面这一份（下拉 / 芯片 / 多选 / 格式 / 视图档 / 界面偏好 / 侧栏余额）：弹窗与表单族早先就拆去了 forms.js，剩下的都是跨页共用的面。1502 刚过线，再涨先问这一枚是不是只有一两页在用 —— 是就回页面，不是新公共件' },
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
  console.log('\n严格判据（CI）：');
  bad += strictGate(cur);
} else {
  const over = bigFilesOver(cur.files);
  console.log('\n超过 ' + LINE_LIMIT + ' 行的文件：' + Object.keys(over).length + ' 个（本地只打印；CI 跑 `--strict` 才会红）');
}
process.exit(bad ? 1 : 0);
