/* ============================================================================
   设计令牌：体检 + 机械替换 + 令牌文件生成。
   规则表与共用件在 tools/token-lib.cjs（值→令牌的映射只有那一份）。

   用法：
     node tools/tokenize-css.cjs                 体检：列出裸值（默认只读）
     node tools/tokenize-css.cjs --quiet         只报总数
     node tools/tokenize-css.cjs --write         机械替换（只动点名的文件；不给名字＝全部样式文件）
     node tools/tokenize-css.cjs --write --js    连 JS 内联 style、HTML 模板源一起改
     node tools/tokenize-css.cjs --tokens        按当前代码实际用到的值重写 web/styles/tokens.css
     node tools/tokenize-css.cjs --map           打印「值 → 令牌名」映射（给人看）
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./token-lib.cjs');

const ROOT = L.ROOT, STYLE_DIR = L.STYLE_DIR, TOKENS_CSS = L.TOKENS_CSS;
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const QUIET = argv.includes('--quiet');
const WITH_JS = argv.includes('--js');
const EMIT_TOKENS = argv.includes('--tokens');
const PRINT_MAP = argv.includes('--map');
const named = argv.filter(a => !a.startsWith('--'));

/* ---------------------------------------------------------------------------
   一、值的改写
   --------------------------------------------------------------------------- */
/** 把一条声明的值切成「var(...) 段」与「普通段」。
    var() 里的东西**不能动**：里面可能是 var(--sbw, 66px) 这种兜底值，
    把 66px 也换成令牌会写出 var(--sbw, var(--sp-66)) —— 令牌不存在，布局直接坏掉。 */
function splitVars(value) {
  const parts = [];
  let i = 0;
  while (i < value.length) {
    const idx = value.indexOf('var(', i);
    if (idx < 0) { parts.push({ text: value.slice(i), isVar: false }); break; }
    if (idx > i) parts.push({ text: value.slice(i, idx), isVar: false });
    let depth = 0, j = idx + 3;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') { depth--; if (depth === 0) break; }
    }
    const text = value.slice(idx, Math.min(j + 1, value.length));
    parts.push({ text, isVar: true });
    i = j + 1;
  }
  return parts;
}

/** 只对普通段做替换。 */
function outsideVars(value, fn) {
  return splitVars(value).map(p => (p.isVar ? p.text : fn(p.text))).join('');
}

/** var(--x, 兜底) → var(--x)：兜底值本身就是第二份会漂移的数（AGENTS.md §3.4）。 */
function stripFallbacks(value, stats) {
  return splitVars(value).map(p => {
    if (!p.isVar) return p.text;
    const inner = p.text.slice(4, -1);
    let depth = 0, comma = -1;
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { comma = k; break; }
    }
    if (comma < 0) return p.text;
    const name = inner.slice(0, comma).trim();
    stats.fallback++;
    return `var(${name})`;
  }).join('');
}

/** 把一条声明的值里的 px 换掉。tier 决定换哪一档。 */
function replacePx(value, tier, stats) {
  return outsideVars(value, seg => seg.replace(/(-?\d*\.?\d+)px\b/g, (all, num) => {
    const n = parseFloat(num);
    if (n === 0) return all;
    const abs = Math.abs(n);
    if (tier === 'hair' && abs > L.HAIR_MAX) return all;
    if (tier === 'sp' && abs > 64) return all;      // 定位/离屏用的巨大偏移不是档位
    stats.replaced++;
    const name = L.tokName(tier, abs);
    if (n < 0) return `calc(-1 * var(${name}))`;
    return `var(${name})`;
  }));
}

/** border / outline 简写：只有「宽度」那一段换成 --hair，别把 solid/颜色换了。 */
function replaceBorder(value, stats) {
  return outsideVars(value, seg => seg.replace(/(^|[\s(])(-?\d*\.?\d+)px\b/g, (all, pre, num) => {
    const n = parseFloat(num);
    if (n === 0) return all;
    const abs = Math.abs(n);
    if (abs > L.HAIR_MAX) return all;
    stats.replaced++;
    const name = L.tokName('hair', abs);
    if (n < 0) return pre + `calc(-1 * var(${name}))`;
    return pre + `var(${name})`;
  }));
}

function replaceColor(value, stats) {
  /* 先剥兜底值，再换色值 —— 顺序反了会把 var(--panel,#fff) 变成 var(--panel,var(--on-acc))，
     兜底就没剥干净。 */
  let out = stripFallbacks(value, stats);
  for (const [hex, tok] of Object.entries(L.COLOR_MAP)) {
    const re = new RegExp('(^|[\\s,(])' + hex.replace('#', '\\#') + '(?=($|[\\s,);]))', 'gi');
    out = out.replace(re, (x, pre) => { stats.color++; return pre + `var(${tok})`; });
  }
  /* 十六进制基色：键归一化成 6 位小写。 */
  out = out.replace(/#([0-9a-fA-F]{3,8})\b/g, (all, hx) => {
    let h = hx.toLowerCase();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    const tok = L.HEX_BASE[h];
    if (!tok) return all;
    stats.color++;
    return `var(${tok})`;
  });
  /* rgba()：基色查表 + 透明度现算（不看空格与 .0 写法）。 */
  out = out.replace(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/gi,
    (all, r, g, b, a) => {
      const base = L.RGBA_BASE[[r, g, b].map(x => String(parseFloat(x))).join(',')];
      if (!base) return all;
      const pct = Math.round(parseFloat(a) * 100000) / 1000;   // 0.14 → 14（别写成 14.000000000000002）
      stats.color++;
      return `color-mix(in srgb, var(${base}) ${pct}%, transparent)`;
    });
  return out;
}

/* 时长：按**毫秒值**命名（--dur-120 就是 120ms），与尺寸档位同一套规则。
   只认这几个值 —— 别的时长（各自动画自己的周期）留在定义旁边，不进令牌表。 */
const DUR_ALLOWED = new Set([100, 120, 140, 150, 160, 180, 200, 250, 280, 400, 800, 900, 1100, 1200, 1400, 1600]);
function replaceDur(value, stats) {
  return outsideVars(value, seg => seg.replace(/(\d*\.?\d+)(ms|s)\b/g, (all, num, unit) => {
    const n = parseFloat(num);
    const ms = unit === 's' ? Math.round(n * 1000) : n;
    if (!DUR_ALLOWED.has(ms)) return all;
    stats.replaced++;
    return `var(--dur-${ms})`;
  }));
}

/* 按顶层逗号切阴影的多层（rgba() 里的逗号不算）。 */
function splitTopLevel(v) {
  const out = []; let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 一层阴影：整层命中阴影表就换成令牌；环形（0 0 0 Npx）换成 --hair-N；
    inset 色带（3px 的那条）换成 --accent-bar。 */
function shadowLayer(layer, stats) {
  if (L.SHADOW_MAP[layer]) { stats.replaced++; return `var(${L.SHADOW_MAP[layer]})`; }
  let out = outsideVars(layer, seg => seg.replace(/0 0 0 (\d*\.?\d+)px/g, (all, n) => {
    const num = parseFloat(n);
    if (num > L.HAIR_MAX) return all;
    stats.replaced++;
    return `0 0 0 var(${L.tokName('hair', num)})`;
  }));
  if (/^inset\b/.test(out)) {
    out = outsideVars(out, seg => seg.replace(/(\d*\.?\d+)px/g, (all, n) => {
      if (parseFloat(n) !== 3) return all;
      stats.replaced++;
      return 'var(--accent-bar)';
    }));
  }
  return out;
}

function handleShadow(value, stats) {
  return splitTopLevel(value).map(l => shadowLayer(l, stats)).join(', ');
}

/* ---------------------------------------------------------------------------
   二、文件清单
   --------------------------------------------------------------------------- */
function styleFiles() {
  const namedAbs = named.map(f => path.resolve(f));
  const list = (namedAbs.length ? namedAbs
    : fs.readdirSync(STYLE_DIR).filter(f => f.endsWith('.css')).map(f => path.join(STYLE_DIR, f)))
    .filter(p => fs.existsSync(p) && p !== TOKENS_CSS);
  return list;
}
/* 导演台的样式不在 .css 里：web/director/template.html 的 <style> 块在运行时被
   取出来注进页面（index.js 的 extractTemplate）。那一块同样要过令牌。 */
function htmlFiles() {
  if (!WITH_JS) return [];
  return L.walkSrc(path.join(ROOT, 'web'), p => p.endsWith('.html'));
}
function jsFiles() {
  if (!WITH_JS) return [];
  return L.walkSrc(path.join(ROOT, 'web'), p => /\.(js|mjs|cjs)$/.test(p));
}
/* 模板源（tools/vue-templates/*.html）：预编译进 web/render/*.js，等于活代码 ——
   它不在 web/ 下，但一样会带着硬编码上线，所以也在这把尺子的射程里。 */
function templateFiles() {
  if (!WITH_JS) return [];
  const dir = path.join(ROOT, 'tools', 'vue-templates');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.html')).map(f => path.join(dir, f));
}

/* ---------------------------------------------------------------------------
   三、改写
   --------------------------------------------------------------------------- */
/** 一条声明的改写：算出新值。 */
function declEdit(prop, value, stats) {
  const name = prop.toLowerCase();
  if (name.startsWith('--')) return null;                 // 自定义属性：运行时写的，不动
  let next = value;
  const tier = L.tierOf(name);
  if (tier === 'hair') next = replaceBorder(next, stats);
  else if (tier) next = replacePx(next, tier, stats);
  /* 阴影先处理：整层命中阴影表就换成令牌，剩下的层再走颜色表 */
  if (name === 'box-shadow') next = handleShadow(next, stats);
  if (L.COLORISH.has(name)) next = replaceColor(next, stats);
  if (/^(transition|animation)$/.test(name)) next = replaceDur(next, stats);
  /* 百分比别带着浮点尾巴（14.000000000000002% 这种是噪音）。 */
  next = next.replace(/(\d+\.\d{4,})%/g, (m, n) => (Math.round(parseFloat(n) * 1000) / 1000) + '%');
  if (next === value) return null;
  return next.trim();
}

/** 按收集到的编辑改写原文（从后往前，索引不失效）。 */
function applyEdits(src, edits) {
  if (!edits.length) return src;
  let out = src;
  for (let i = edits.length - 1; i >= 0; i--) {
    const [s, e, text] = edits[i];
    out = out.slice(0, s) + text + out.slice(e);
  }
  return out;
}

function transformCss(src, stats) {
  const masked = L.maskCommentsKeepLength(src);
  const edits = [];
  let m;
  L.CSS_DECL.lastIndex = 0;
  while ((m = L.CSS_DECL.exec(masked))) {
    const prop = (m[3] || '') + m[4];
    const value = m[5];
    const next = declEdit(prop, value, stats);
    if (next === null) continue;
    const start = m.index + m[0].length - value.length;
    edits.push([start, start + value.length, next]);
  }
  return applyEdits(src, edits);
}

function transformInline(src, stats) {
  const masked = L.maskCommentsKeepLength(src);
  const edits = [];
  let m;
  const re = /style\s*=\s*"([^"]*)"/g;
  re.lastIndex = 0;
  while ((m = re.exec(masked))) {
    const inner = m[1];
    const innerMasked = L.maskCommentsKeepLength(inner);
    const sub = [];
    let k;
    L.INLINE_DECL.lastIndex = 0;
    while ((k = L.INLINE_DECL.exec(innerMasked))) {
      const prop = (k[3] || '') + k[4];
      const value = k[5];
      const next = declEdit(prop, value, stats);
      if (next === null) continue;
      const start = k.index + k[0].length - value.length;
      sub.push([start, start + value.length, next]);
    }
    if (!sub.length) continue;
    const newInner = applyEdits(inner, sub);
    /* 内层内容的起点要**按开引号算**：m[0].length - inner.length 落在闭引号上，
       差一位 → 闭引号连同后面 17 个字符被一起替换掉（HTML 结构直接烂掉）。 */
    const qStart = m.index + m[0].indexOf('"');
    const innerStart = qStart + 1;
    edits.push([innerStart, innerStart + inner.length, newInner]);
  }
  return applyEdits(src, edits);
}

/* HTML 里的 <style> 块与行内 style 属性：两种都要改。
   导演台的项目菜单、剧本粘贴板那一处，样式是写在行内 style 属性里的 ——
   只扫 <style> 块会漏掉它们。 */
function transformHtml(src, stats) {
  const out = src.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (all, open, inner, close) => {
    const next = transformCss(inner, stats);
    return next === inner ? all : open + next + close;
  });
  return transformInline(out, stats);
}

/* ---------------------------------------------------------------------------
   四、令牌文件生成：按当前代码实际用到的值
   --------------------------------------------------------------------------- */
function collectNeeded() {
  const need = { sp: new Set(), fs: new Set(), radius: new Set(), hair: new Set() };
  const scanTierValues = (src, declRe) => {
    let m;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(src))) {
      const name = ((m[3] || '') + m[4]).toLowerCase(), value = m[5];
      const tier = L.tierOf(name);
      if (!tier) continue;
      for (const pm of value.matchAll(/(-?\d*\.?\d+)px\b/g)) {
        const n = parseFloat(pm[1]);
        const abs = Math.abs(n);
        if (!n) continue;
        if (tier === 'hair' && abs > L.HAIR_MAX) continue;
        if (tier === 'sp' && abs > 64) continue;
        need[tier].add(abs);
      }
    }
  };
  for (const f of fs.readdirSync(STYLE_DIR)) {
    if (!f.endsWith('.css')) continue;
    scanTierValues(L.maskComments(fs.readFileSync(path.join(STYLE_DIR, f), 'utf8')), L.CSS_DECL);
  }
  if (WITH_JS) {
    for (const f of [...jsFiles(), ...htmlFiles(), ...templateFiles()]) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/style\s*=\s*"([^"]*)"/g)) scanTierValues(m[1], L.INLINE_DECL);
      if (f.endsWith('.html')) {
        for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) scanTierValues(m[1], L.CSS_DECL);
      }
    }
  }
  return need;
}

function fmtTier(set, tier) {
  return [...set].sort((a, b) => a - b).map(v => `${L.tokName(tier, v)}:${v}px`).join('; ');
}

/* ---------------------------------------------------------------------------
   五、命令行
   --------------------------------------------------------------------------- */
function main() {
  if (PRINT_MAP) {
    const need = collectNeeded();
    for (const tier of ['sp', 'fs', 'radius', 'hair']) {
      console.log(`\n--${tier}--`);
      console.log([...need[tier]].sort((a, b) => a - b).map(v => `  ${v}px → ${L.tokName(tier, v)}`).join('\n'));
    }
    process.exit(0);
  }

  if (argv.includes('--collapse')) {
    /* 间距收敛的干跑：只报「哪个补档会收成哪一档、牵动多少处」，不写盘。
       真要收的那天，把 tokens.css 里的档位改掉即可（调用点不用动）。 */
    const files2 = [...styleFiles(), ...jsFiles(), ...htmlFiles(), ...templateFiles()];
    const use = new Map();
    for (const p of files2) {
      const src = L.maskComments(fs.readFileSync(p, 'utf8'));
      for (const m of src.matchAll(/var\(--sp-([\d.]+)\)/g)) {
        const k = m[1];
        use.set(k, (use.get(k) || 0) + 1);
      }
    }
    console.log('主档（不收）：' + L.SP_MAIN.map(v => v + 'px').join(' ') + '\n');
    console.log('补档 → 候选收敛目标（牵动处数）：');
    const rows = [...use.entries()]
      .map(([k, n]) => [k, n, L.SP_COLLAPSE[parseFloat(k)]])
      .filter(r => r[2] !== undefined)
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
    let total = 0;
    for (const [k, n, to] of rows) { console.log(`  --sp-${k} → --sp-${to}px   牵动 ${n} 处`); total += n; }
    console.log(`\n合计 ${rows.length} 个补档、${total} 处引用。`);
    console.log('⚠ 这是**候选**，收敛会改画面 —— 属于布局重构那一轮的设计决定；');
    console.log('  真要收：只改 tokens.css 里的档位值，调用点不用动。');
    process.exit(0);
  }

  if (EMIT_TOKENS) {
    const need = collectNeeded();
    const header = fs.readFileSync(TOKENS_CSS, 'utf8').split('/* ---------- 尺寸档位 ----------')[0];
    const body = `/* ---------- 尺寸档位（名字即值） ----------
   间距：${fmtTier(need.sp, 'sp')}
   字号：${fmtTier(need.fs, 'fs')}
   圆角：${fmtTier(need.radius, 'radius')}
   描边宽：${fmtTier(need.hair, 'hair')} */\n`;
    fs.writeFileSync(TOKENS_CSS, header + body);
    console.log('✓ 已重写 ' + path.relative(ROOT, TOKENS_CSS));
    process.exit(0);
  }

  /* ---- 默认：体检 ---- */
  let total = 0;
  const allFiles = [...styleFiles(), ...jsFiles(), ...htmlFiles(), ...templateFiles()];
  for (const p of allFiles) {
    const raw = fs.readFileSync(p, 'utf8');
    const src = L.maskComments(raw);
    const rows = L.scanSource(src, L.kindOfSrc(p));
    total += rows.length;
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    if (QUIET) continue;
    console.log(rows.length ? `✗ ${rel}：${rows.length} 处裸值` : `✓ ${rel}：0 处裸值`);
    rows.slice(0, 40).forEach(r => console.log(`    ${r.name}: ${r.value}  —— ${r.why}`));
    if (rows.length > 40) console.log(`    …另 ${rows.length - 40} 处`);
  }
  if (!QUIET) console.log(`合计 ${total} 处待收敛`);

  if (WRITE) {
    const stats = { replaced: 0, color: 0, fallback: 0 };
    for (const p of allFiles) {
      const src = fs.readFileSync(p, 'utf8');
      const kind = L.kindOfSrc(p);
      const next = kind === 'js' ? transformInline(src, stats) : kind === 'html' ? transformHtml(src, stats) : transformCss(src, stats);
      if (next !== src) {
        fs.writeFileSync(p, next);
        console.log('✓ 已改写 ' + path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    }
    console.log('机械替换计数：', stats);
  }
  process.exit(total ? 1 : 0);
}

if (require.main === module) main();

module.exports = { scanSource: L.scanSource, kindOfSrc: L.kindOfSrc };
