/* 设计令牌体检：统计 CSS 里剩下的**裸字面量**（px / 色值 / 圆角 / 时长），按文件列出。
   默认**只读**（AGENTS.md §3.4 把它当收敛统计工具用；以前默认就地改写，
   照着「跑一次看看」的念头执行就会把用户样式改掉）。`--write` 才做机械替换，且只动点名的文件。
   退出码：有裸值时非零（给判据用），`--quiet` 只报总数。 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', 'web', 'styles');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const QUIET = argv.includes('--quiet');
const named = argv.filter(a => !a.startsWith('--'));
const files = (named.length ? named.map(f => path.resolve(f))
  : fs.readdirSync(root).filter(f => f.endsWith('.css') && f !== 'tokens.css').map(f => path.join(root, f)))
  .filter(p => fs.existsSync(p));

/* 一次性机械替换用的映射（只在这些明确对等的档位上换，别把设计决定混进统计里）。 */
const SP = { '4px': 'var(--sp-1)', '8px': 'var(--sp-2)', '12px': 'var(--sp-3)', '16px': 'var(--sp-4)', '24px': 'var(--sp-5)', '32px': 'var(--sp-6)' };
const FS = { '12px': 'var(--fs-1)', '13px': 'var(--fs-2)', '14px': 'var(--fs-3)', '16px': 'var(--fs-4)', '20px': 'var(--fs-5)', '24px': 'var(--fs-6)' };
const RAD = { '6px': 'var(--radius-1)', '10px': 'var(--radius-2)', '14px': 'var(--radius-3)' };
const COLORS = { '#fff': 'var(--on-acc)', '#000': 'var(--media-bg)', '#c4c9dc': 'var(--scroll)', '#2a3046': 'var(--scroll)' };
const THEME = ['bg', 'panel', 'panel2', 'line', 'txt', 'sub', 'acc', 'acc2', 'ok', 'warn', 'err', 'pri', 'input', 'thumbbg', 'thumbfg', 'local', 'cloud', 'both', 'atbg', 'on-acc', 'media-bg', 'scroll'];

/* 裸值判据（照 AGENTS §3.4 那句「不要再写裸的 4/8/12/16/24/32 间距与 6/10/14 圆角」的范围）：
   只认**间距 / 字号 / 圆角 / 时长 / 色值 / 令牌兜底值**这几类。
   `border: 1px`、`outline: 2px`、`flex-basis`、宽高与定位里的 px 是布局事实，不是档位，不算违例。 */
const DECL_RE = /(^|[;{}]\s*)([a-z-]+)\s*:\s*([^;{}]+?)\s*;/gi;
const PX = /(?:^|\s)-?\d*\.?\d+px(?=[\s,;)!]|$)/i;
const COLORISH = new Set(['color', 'background', 'background-color', 'border', 'border-color', 'border-top',
  'border-bottom', 'box-shadow', 'outline', 'outline-color', 'fill', 'stroke', 'accent-color', 'caret-color']);
const HEX = /#([0-9a-f]{3,8})\b/i;
const FN_COLOR = /\brgba?\(/i;
const DUR = /(?:^|\s)\d+ms(?=[\s,)]|$)/i;

function bareRows(p) {
  const s = fs.readFileSync(p, 'utf8');
  const rows = [];
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(s))) {
    const name = m[2].toLowerCase(), value = m[3];
    const line = s.slice(0, m.index).split('\n').length;
    const why = [];
    if (PX.test(value)) {
      if (/^(margin|padding|gap|row-gap|column-gap)$/.test(name) || /-(top|right|bottom|left)$/.test(name)) why.push('间距 px');
      else if (name === 'font-size') why.push('字号 px');
      else if (name === 'border-radius') why.push('圆角 px');
    }
    if (COLORISH.has(name) && (HEX.test(value) || FN_COLOR.test(value))) why.push('色值');
    if (name === 'transition' && DUR.test(value)) why.push('时长 ms');
    if (/var\(--[a-z0-9-]+\s*,\s*[^)]+\)/i.test(value)) why.push('令牌兜底值');
    if (why.length) rows.push({ line, decl: name + ': ' + value, why: why.join(' / ') });
  }
  return rows;
}

function mapWords(value, map) {
  const parts = value.split(/(\s+)/);
  let hit = false;
  const out = parts.map(p => {
    const k = p.trim().toLowerCase();
    if (map[k] && p === p.trim()) { hit = true; return map[k]; }
    return p;
  });
  return hit ? out.join('') : null;
}

let total = 0;
for (const p of files) {
  const rows = bareRows(p);
  total += rows.length;
  const rel = path.relative(path.resolve(__dirname, '..'), p).replace(/\\/g, '/');
  if (QUIET) continue;
  console.log(rows.length ? `✗ ${rel}：${rows.length} 处裸值` : `✓ ${rel}：0 处裸值`);
  rows.slice(0, 40).forEach(r => console.log(`    ${r.line}: ${r.decl}  —— ${r.why}`));
  if (rows.length > 40) console.log(`    …另 ${rows.length - 40} 处`);
}
if (WRITE) {
  const stats = { decl: 0, color: 0, fallback: 0 };
  for (const p of files) {
    let s = fs.readFileSync(p, 'utf8');
    for (const name of THEME) {
      const re = new RegExp('var\\(--' + name.replace(/[-]/g, '\\-') + '\\s*,\\s*[^)]+\\)', 'g');
      s = s.replace(re, () => { stats.fallback++; return 'var(--' + name + ')'; });
    }
    s = s.replace(DECL_RE, (all, lead, prop, value) => {
      const name = prop.toLowerCase();
      let next = value.trim();
      if (name === 'font-size' && FS[next]) { next = FS[next]; stats.decl++; }
      else if (['gap', 'row-gap', 'column-gap', 'padding', 'margin'].includes(name)) {
        const m = mapWords(next, SP); if (m) { next = m; stats.decl++; }
      } else if (name === 'border-radius' && RAD[next]) { next = RAD[next]; stats.decl++; }
      else if (name === 'transition') {
        next = next.replace(/(^|\s)(120ms|180ms)(?=\s|,|$)/g, (x, pre, d) => { stats.decl++; return pre + (d === '120ms' ? 'var(--dur-1)' : 'var(--dur-2)'); });
      }
      for (const [hex, tok] of Object.entries(COLORS)) {
        const re = new RegExp('(^|[\\s,(])' + hex + '(?=($|[\\s,);]))', 'gi');
        next = next.replace(re, (x, pre) => { stats.color++; return pre + tok; });
      }
      return lead + prop + ': ' + next + ';';
    });
    fs.writeFileSync(p, s);
    console.log('✓ 已改写 ' + path.basename(p));
  }
  console.log('机械替换计数（只算对等档位）：', stats);
}
if (!QUIET) console.log(`合计 ${total} 处待收敛${WRITE ? '' : '（只读，未改文件；要改写加 --write 并点名文件）'}`);
process.exit(total ? 1 : 0);
