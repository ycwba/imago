#!/usr/bin/env node
/* tests/support.cjs —— 判据脚本共用的几件小事（只给 tests/ 内部用，不是运行时代码）。
   为什么要有这一份：routes-smoke / providers-validate / static-guards 都要
     · 扫源码（web/ 与 server/，排除生成物与 vendor）
     · 「找到某个东西住在哪儿」的适配层（路由 ctx 的注入点按域拆在 server/ 顶层，名字会挪）
     · 例外登记表（违例只许减不许增）的同一套比对语义
   同一套判据写两份就一定漂移，所以住这里。 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rel = p => path.relative(root, p).split(path.sep).join('/');
const abs = p => path.join(root, p);
const read = f => fs.readFileSync(abs(f), 'utf8');
const exists = f => fs.existsSync(abs(f));

/* ---------- 源码扫描 ---------- */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(ent.name)) out.push(full);
  }
  return out;
}
/* 判据扫的是「人写的源码」：web/render/ 是预编译生成物、web/vendor/ 与 Vue vendor 是第三方构建产物。 */
function webSources() {
  return walk(abs('web'))
    .filter(p => !/[\\/]render[\\/]/.test(p) && !/[\\/]vendor[\\/]/.test(p) && !/vue\.runtime/.test(p))
    .sort();
}
/* 导演台 engine 层的文件清单：engine.js（状态与接线）+ engine/<域>.js（按域搬出去的函数）。
   备份文件 `.pre-<域>` 不是源码，不进这一份。 */
function engineFiles() {
  const dir = abs('web/director/engine');
  const mods = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => /^[a-z0-9-]+\.js$/.test(f)).sort().map(f => 'web/director/engine/' + f)
    : [];
  return ['web/director/engine.js'].concat(mods);
}
/* 钉「engine 这一层只有一份实现」的文本判据读这一份，不读裸 engine.js —— 函数搬进域模块之后
   还是同一层的代码，判据不跟着走，每搬一块就凭空红一片（那是判据的位置错了，不是实现错了）。 */
function engineLayer() { return engineFiles().map(read).join('\n'); }
/* 传给判据的既可能是绝对路径（webSources 给的），也可能是**内存里合成的**相对路径（architecture.cjs 的自检造的假文件）。假的不能拿去 cwd 拼绝对路径 —— 直接当仓库相对路径用。 */
function asRel(p) {
  return typeof p === 'string' && !path.isAbsolute(p) ? p.split(path.sep).join('/') : rel(p);
}
function serverSources() {
  return walk(abs('server')).sort();
}
/* server/ 顶层（不含 routes/ 子目录）：路由 ctx 的注入点目前住在 app.js，
   拆开后可能住在 wiring 一类的新文件里，所以只按「server 顶层任意文件」找。 */
function serverTopLevel() {
  return fs.readdirSync(abs('server'), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => 'server/' + e.name)
    .sort();
}

/* ---------- 源码扫描的两件小事（静态判据共用） ---------- */
/* 字符串/模板字面量抽取：跳过注释，返回 [{ text, start, end, quote }]。
   模板串里的 ${…} 不递归解析（里面的字符串会被当成模板的一部分）—— 判据要的是
   「这一段是人写的话」，不是编译器，宁可少判也不瞎判。 */
function literals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i += 2; while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; const start = i; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      out.push({ text: src.slice(start + 1, i), start, end: i, quote: q });
      i++;
      continue;
    }
    i++;
  }
  return out;
}
/* 函数体范围抽取：function 声明、`const NAME = (…) => {`、对象里的方法简写。
   返回按**外层在前**排好的 [{ name, start, bodyStart, bodyEnd }]；调用点落在哪一层，
   就是「它在哪个函数里」。够用就好：判据要的是「同一个函数体内有没有那句护栏」。 */
const RESERVED_FN = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'try', 'finally', 'with', 'typeof', 'await', 'new', 'delete', 'void', 'in', 'of', 'case', 'default']);
function functionsIn(src) {
  const found = [];
  const push = (name, openParen) => {
    const open = src.indexOf('{', openParen);
    if (open < 0) return;
    const close = matchBrace(src, open);
    if (close < 0) return;
    found.push({ name: name || '<anon>', start: openParen, bodyStart: open, bodyEnd: close });
  };
  const reDecl = /(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([\w$]*)\s*\(/g;
  let m;
  while ((m = reDecl.exec(src))) push(m[1] || '<anon>', m.index + m[0].length - 1);
  const reArrow = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*)?\(?[^;{]*?\)?\s*=>\s*\{/g;
  while ((m = reArrow.exec(src))) push(m[1], m.index + m[0].length - 1);
  const reMethod = /(?:^|\s)(?:async\s+|static\s+|get\s+|set\s+|\*\s*)?([\w$]+)\s*\([^()]*\)\s*\{/gm;
  while ((m = reMethod.exec(src))) {
    if (RESERVED_FN.has(m[1])) continue;
    push(m[1], m.index + m[0].length - 1);
  }
  /* 去重并按「外层在前、内层在后」排序：同一起点只留一条。 */
  const seen = new Set();
  const uniq = [];
  for (const f of found.sort((a, b) => a.start - b.start || b.bodyEnd - a.bodyEnd)) {
    const k = f.start + ':' + f.name;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
  }
  return uniq;
}
/* 一个下标落在哪个函数里：取**最内层**那个。找不到就是顶层。 */
function enclosingFunction(funcs, idx) {
  let hit = null;
  for (const f of funcs) {
    if (f.start <= idx && idx <= f.bodyEnd) {
      if (!hit || f.start >= hit.start && f.bodyEnd <= hit.bodyEnd) hit = f;
    }
  }
  return hit;
}

/* ---------- 「找一个落点」的适配层通用件 ---------- */
/* 从某个下标处的 `{` 起做配对（跳过字符串与注释），返回右括子的下标。 */
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') i++; else if (src[i] === q) break; i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/* 取一个对象字面量**顶层**的键名（嵌套对象里的键不算）。 */
function objectKeys(src, openIdx) {
  const close = matchBrace(src, openIdx);
  if (close < 0) return [];
  const body = src.slice(openIdx + 1, close);
  const keys = [];
  let depth = 0, token = '', start = 0;
  const push = () => {
    const t = token.trim();
    token = '';
    if (!t) return;
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(t) || /^([A-Za-z_$][\w$]*)$/.exec(t) || /^'([^']+)'/.exec(t) || /^"([^"]+)"/.exec(t);
    if (m) keys.push(m[1]);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { push(); start = i + 1; continue; }
    else if (c === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    else if (c === '/' && body[i + 1] === '*') { i += 2; while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++; i++; continue; }
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; let j = i + 1;
      while (j < body.length) { if (body[j] === '\\') j++; else if (body[j] === q) break; j++; }
      token += body.slice(i, j + 1); i = j; continue;
    }
    token += body[i];
    if (body[i] === ',' && depth === 0) { push(); start = i + 1; }
    void start;
  }
  push();
  return [...new Set(keys)];
}

/* 路由 ctx 的注入点：`createXxxRoutes({ a, b, c })` 里那一份键清单。
   同样是适配层 —— 不假定它住在 app.js，扫 server/ 顶层所有文件；
   真找不到就返回 error，让判据明确说「注入点找不到了，这一处要改 tests/routes-smoke.cjs」。 */
function findWiring(factoryName) {
  for (const f of serverTopLevel()) {
    const src = read(f);
    const re = new RegExp('\\b' + factoryName + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      if (new RegExp('\\bfunction\\s+' + factoryName + '\\b').test(src.slice(Math.max(0, m.index - 200), m.index))) continue;
      const open = src.indexOf('{', m.index + m[0].length - 1);
      if (open < 0 || open - m.index > 200) continue;
      const keys = objectKeys(src, open);
      if (keys.length) return { file: f, keys };
    }
  }
  return { file: null, keys: [], error: '找不到 ' + factoryName + ' 的注入点（server/ 顶层没有 `' + factoryName + '({ … })` 调用）' };
}

/* ---------- 分层矩阵与「公共面」（架构判据与公共件目录判据共用这一份） ---------- */
/* 分层方向（下层不许读上层）：
   下层不许读上层 —— core / ui / domain 互不横向依赖，features 不许碰页面与导演台，
   server 不许出现在前端模块的 import 里。页面与导演台在最上层，读谁都行。 */
const LAYER_FORBIDDEN = {
  core: ['domain', 'ui', 'features', 'pages', 'director'],
  ui: ['domain', 'features', 'pages', 'director'],
  domain: ['ui', 'features', 'pages', 'director'],
  features: ['pages', 'director'],
  server: ['core', 'ui', 'domain', 'features', 'pages', 'director', 'shared'],
};
function layerOf(relPath) {
  const r = String(relPath).split(path.sep).join('/');
  if (r === 'web/app.js' || r === 'shell.html') return 'shared';   // 外壳本体：谁都能引它，它不属于任何一层
  if (r.startsWith('web/core/')) return 'core';
  if (r.startsWith('web/ui/')) return 'ui';
  if (r.startsWith('web/domain/')) return 'domain';
  if (r.startsWith('web/features/')) return 'features';
  if (r.startsWith('web/pages/')) return 'pages';
  if (r.startsWith('web/director/')) return 'director';
  if (r.startsWith('server/')) return 'server';
  return 'shared';
}
/* 注释要去掉再扫「谁读了哪个公共面」：判据说明里满是「见 workbench.js 的 Wb.thumbs」，
   把注释算成使用点的话，每一条解释都在给自己报违例。字符串保留（模板里拼的界面也是使用点）。 */
function stripComments(src) {
  let out = '', i = 0, q = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += src[++i] || ''; i++; continue; }
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
/* web/ui/ 里那六个是「全站基础设施」，不是组件：
   网络 / 本地存储 / IndexedDB / 提示 / 数据同步 / 跳页各只有一份实现。
   任何一层要用只有一份实现的东西，就该用它 —— 把它们算成「ui 组件依赖」会把
   「assetlib 里所有 fetch 都走 Net」这种正确写法报成违例，判据就没人当真了。
   组件面（Dropdowns / Confirm / UiDialog / Chips / Wb / AssetPicker …）不在这里：
   domain 去点组件仍然是违反分层，要红。 */
/* `LS` 与 Store 同属「全站基础设施面」：它是 localStorage 的唯一同步信封读法（G9 判据要求
   任何一层都不许裸碰 localStorage）。domain 层读自己的偏好/提示词正需要它，与 import ui 组件不同
   —— 不把它算成跨层依赖；G9 那条判据本身就守着「除了 ui.js 外面没有第二份实现」。 */
const UI_INFRA_FACES = new Set(['Net', 'Store', 'Kv', 'Toast', 'DataSync', 'GoPage', 'ErrBanner', 'LS']);
function isInfra(name, layer) { return layer === 'ui' && UI_INFRA_FACES.has(name); }

/* 公共面 = `window.<首字母大写> = …`（浏览器经典脚本挂一个 window.<Name> 面）。
   `__*` 那些后门不算：它们是外壳与页面之间的钩子，
   不是某一层的实现；小写的（esc / icon / toast / fmtBytes）是别名，也不是一层对另一层的依赖。 */
/* 默认扫真实仓库；architecture.cjs 的自检要拿一段**内存里的**合成源码验证「这条判据真会红」，
   所以 files/read/faces 都能注入（注入的是判据的输入，不是判据本身）。 */
function globalFaces(opts = {}) {
  const defs = new Map();                       // 面名 → { files: [定义处], layers: [层] }
  const rd = opts.read || read;
  for (const f of (opts.files || webSources()).map(asRel)) {
    const src = stripComments(rd(f));
    for (const m of src.matchAll(/\bwindow\.([A-Z][\w$]*)\s*=[^=]/g)) {
      const name = m[1];
      if (!defs.has(name)) defs.set(name, { files: [], layers: [] });
      const d = defs.get(name);
      if (!d.files.includes(f)) d.files.push(f);
      const l = layerOf(f);
      if (!d.layers.includes(l)) d.layers.push(l);
    }
  }
  return defs;
}
/* 一个文件里「读了哪个面、读了几次」：`window.Wb` 与裸 `Wb.` / `Wb[` / `Wb(` 都算使用点。
   自己定义的那个面不算读自己。 */
function faceReads(src, name) {
  const re = new RegExp('(?:\\bwindow\\.' + name + '\\b|\\b' + name + '\\b\\s*(?=[.\\[(]))', 'g');
  return (src.match(re) || []).length;
}

/* 层表违例的例外登记（只许减不许增）。为什么要有它：全站 74 个源码文件里的公共面是**故意**
   挂成 window 的（运行时零构建、没有打包器可以做 import），存量跨层引用是历史事实，
   不是「判据没跑」。所以按「文件 → 面 → 层」逐条登记 + 条数上限，新增一条就直接红。
   每条都要写原因；原因写不出来就该改代码，而不是往表里加一行。
   下面这些条目对应的就是要收敛的那两个方向（两个反例都在里面）。 */
const LAYER_EXCEPTIONS = [
  /* ---- domain 读 ui 的组件面：domain 不该开弹窗、不该自己画卡片 ---- */
  { id: 'web/domain/api.js → Wb [ui]', max: 3, why: '与 workbench 互相引用（同一份任务账两边都碰）：api.js 拆分后这一层只剩取数' },
  { id: 'web/domain/gen-forms.js → Confirm [ui]', max: 1, why: '反例：表单族弹「要不要覆盖」（gen-forms.js 的 window.Confirm.ask）。改法是只返回错误码，问话交给页面/助手' },
  { id: 'web/domain/gen-forms.js → InlinePolish [ui]', max: 4, why: '就地润色组件住在 ui.js/forms.js，AiStream 直接驱动它（拆开后这一层只剩面板接线）' },
  { id: 'web/domain/asset-picker.js → Wb [ui]', max: 5, why: '选素材弹窗自己拼工作台卡片：应换成 Wb.cards 的调用点由页面给（公共件复用）' },
  { id: 'web/domain/asset-picker.js → AiChip [ui]', max: 2, why: 'AI 条件芯片画在弹窗里：芯片是 ui 组件，弹窗本身不该在 domain' },
  { id: 'web/domain/asset-picker.js → PickSel [ui]', max: 1, why: '多选态由 ui.js 的 PickSel 持有，选择器又去读它 —— 两边都是「选择」这一件事的两份' },
  { id: 'web/domain/chars.js → Wb [ui]', max: 5, why: '素材库列表借工作台的卡片/分页标记：拆 Chars 时把界面挪回页面' },
  { id: 'web/domain/chars.js → PromptForm [ui]', max: 1, why: '配音表单直接驱动 ui 的提示词表单' },
  { id: 'web/domain/local.js → Wb [ui]', max: 3, why: '本机资产层读工作台（徽标/格式化）：徽标判据的唯一实现应是 AssetLocal.stateOf，反过来的引用要断' },
  /* ---- ui 读 domain：公共组件层反过来依赖数据层 ---- */
  { id: 'web/ui/workbench.js → Api [domain]', max: 30, why: '工作台是任务层，取数全走 Api.mediaSrc/mediaKey/request + cacheGet/cachePut（缩略图持久层搬代理后新增的取放口）：曾经的三个巨型闭包之二，拆「媒体地址」这一小块才收得动' },
  { id: 'web/ui/workbench.js → AssetLib [domain]', max: 3, why: '历史/详情面板读资产库缓存：与 Api 同批收敛' },
  { id: 'web/ui/workbench.js → AssetLocal [domain]', max: 1, why: '另一个反例：卡片自己拼本机身份。改法是只读 stateOf 的订阅，别在 ui 层算' },
  { id: 'web/ui/workbench.js → PromptLog [domain]', max: 2, why: '卡片详情显示归档提示词，走的是 domain 的读接口：等 workbench 拆薄' },
  { id: 'web/ui/sidebar.js → Api [domain]', max: 6, why: '侧栏余额与注册表都从 Api 取（把侧栏算 ui 层）：改成外壳注入一份 store' },
  { id: 'web/ui/sidebar.js → AssetLocal [domain]', max: 10, why: '侧栏徽标数字读本机身份：与上一条同一处装配问题' },
  { id: 'web/ui/forms.js → Api [domain]', max: 3, why: '表单族里有几处直接问 Api（润色面板的供应方/型号文案）：把表单族切去 forms.js 时原样搬过来，待抽成注入' },
  { id: 'web/ui/datasync.js → PromptLog [domain]', max: 4, why: '导入导出要带提示词归档，于是读了 domain 的 store：等 prompts 层自己导出一个片段' },
  { id: 'web/ui/datasync.js → ModelPrefs [domain]', max: 2, why: '导设置时带上型号偏好：同上，属跨层读数据' },
  { id: 'web/ui/skills.js → TextAI [domain]', max: 1, why: '内置 Skill 正文与 TextAI.DEF 同源，读的是同一份文案定义' },
];

/* 把「现在的违例」算成 id → 条数。id 形如 `文件 → 面名 [层]`，不带行号。 */
function layerViolations(opts = {}) {
  const files = (opts.files || webSources()).map(asRel);
  const rd = opts.read || read;
  const faces = opts.faces || globalFaces(opts);
  const current = {};
  for (const f of files) {
    const lf = layerOf(f);
    const forb = LAYER_FORBIDDEN[lf] || [];
    if (!forb.length) continue;
    const src = stripComments(rd(f));
    for (const [name, d] of faces) {
      if (d.files.includes(f)) continue;
      for (const dl of d.layers) {
        if (!forb.includes(dl)) continue;
        if (isInfra(name, dl)) continue;                    // 全站基础设施面不算跨层依赖（理由见上）
        const n = faceReads(src, name);
        if (!n) continue;
        const id = f + ' → ' + name + ' [' + dl + ']';
        current[id] = (current[id] || 0) + n;
      }
    }
  }
  return current;
}

/* ---------- 断点档位（静态判据 G22 与文档契约共用这一份） ---------- */
/* 媒体查询里的 px 用不了 CSS 变量（var() 在 @media 里不成立），断点只能靠「一份名单 + 两处读它」防漂移：
   改档位就是改这一行，G22 与文档契约跟着同一份名单判。
   1280 那一档不能加回来：设置页改成两栏两滚之后，右栏那条文档只有 900px 上下，
   两列各 400px 放不下「标签 + 下拉 + 输入框 + 单位」那一行。
   档位偏多，布局重构那轮收成 3–5 档。 */
const BREAKPOINTS = [520, 620, 700, 720, 760, 820, 900, 960, 1100, 1180, 1200];

/* ---------- 例外登记表：违例只许减不许增 ---------- */
/* 两种登记粒度，都是数据表，不写 `|| true`：
   · entries —— 按「身份字符串」逐条登记（`{ id, why, max }`，id 里带文件与符号，不写行号）
   · counts  —— 按文件计数（`{ file, why, max }`），适合一条判据在存量里有几十处、
                只能整体收敛的情况（例如空 catch 与 var() 里的色值回退）
   current 是 Map/对象：身份 → 现在的条数。
   新出现的身份，或某身份条数超过登记的 max → 判红；低于 max → 只提示「可以收紧」。 */
function ratchet(current, table, opts = {}) {
  const kind = opts.kind || 'entries';
  const byId = new Map();
  for (const row of table) byId.set(kind === 'counts' ? row.file : row.id, row);
  const grown = [], stale = [];
  for (const [id, n] of Object.entries(current)) {
    const row = byId.get(id);
    if (!row) { grown.push({ id, n, why: '' }); continue; }
    if (n > row.max) grown.push({ id, n, max: row.max, why: row.why });
    else if (n < row.max) stale.push({ id, n, max: row.max });
  }
  for (const row of byId) {
    if (!(row[0] in current)) stale.push({ id: row[0], n: 0, max: row[1].max });
  }
  return { grown, stale, total: Object.values(current).reduce((a, b) => a + b, 0) };
}

/* 把「当前违例」打成可直接粘回源码的表（GUARD_WRITE=1 用）。
   按 file 记数的表（整类收敛，一处加一处就红）和按 id 记条目的表字段名不同，
   打错一张就粘不回去 —— 跟着 kind 走。 */
function printTable(current, note, opts = {}) {
  const field = (opts.kind || 'entries') === 'counts' ? 'file' : 'id';
  const rows = Object.entries(current).sort((a, b) => a[0] < b[0] ? -1 : 1);
  console.log('  // ' + (note || '当前违例') + '：' + rows.length + ' 条');
  for (const [id, n] of rows) console.log(`  { ${field}: '${id}', max: ${n}, why: 'TODO 补一句原因' },`);
  return rows.length;
}

module.exports = { root, rel, asRel, abs, read, exists, walk, webSources, serverSources, serverTopLevel,
  engineFiles, engineLayer,
  matchBrace, objectKeys, findWiring, ratchet, printTable,
  literals, functionsIn, enclosingFunction,
  LAYER_FORBIDDEN, LAYER_EXCEPTIONS, UI_INFRA_FACES, isInfra, layerOf, stripComments, globalFaces, faceReads, layerViolations,
  BREAKPOINTS };
