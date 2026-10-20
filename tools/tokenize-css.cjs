/* 一次性把页面/公共 CSS 里的字面量换成设计令牌；跑完删除。 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', 'web', 'styles');
const files = fs.readdirSync(root).filter(f => f.endsWith('.css') && f !== 'tokens.css');
const SP = { '4px': 'var(--sp-1)', '8px': 'var(--sp-2)', '12px': 'var(--sp-3)', '16px': 'var(--sp-4)', '24px': 'var(--sp-5)', '32px': 'var(--sp-6)' };
const FS = { '12px': 'var(--fs-1)', '13px': 'var(--fs-2)', '14px': 'var(--fs-3)', '16px': 'var(--fs-4)', '20px': 'var(--fs-5)', '24px': 'var(--fs-6)' };
const RAD = { '6px': 'var(--radius-1)', '10px': 'var(--radius-2)', '14px': 'var(--radius-3)' };
const COLORS = { '#fff': 'var(--on-acc)', '#000': 'var(--media-bg)', '#c4c9dc': 'var(--scroll)', '#2a3046': 'var(--scroll)' };
const THEME = ['bg', 'panel', 'panel2', 'line', 'txt', 'sub', 'acc', 'acc2', 'ok', 'warn', 'err', 'pri', 'input', 'thumbbg', 'thumbfg', 'local', 'cloud', 'both', 'atbg', 'on-acc', 'media-bg', 'scroll'];
let stats = { decl: 0, color: 0, fallback: 0 };
function mapWords(value, map) {
  const parts = value.split(/(\s+)/);
  let hit = false;
  const out = parts.map(p => {
    const k = p.trim().toLowerCase();
    if (map[k] && p === p.trim()) { hit = true; return map[k]; }
    return p;
  });
  return hit ? { value: out.join(''), hit } : null;
}
for (const f of files) {
  const p = path.join(root, f);
  let s = fs.readFileSync(p, 'utf8');
  // 去掉已知主题变量的兜底色：令牌由 tokens.css 保证存在
  for (const name of THEME) {
    const re = new RegExp('var\\(--' + name.replace(/[-]/g, '\\-') + '\\s*,\\s*[^)]+\\)', 'g');
    s = s.replace(re, () => { stats.fallback++; return 'var(--' + name + ')'; });
  }
  s = s.replace(/(^|[;{]\s*)([a-z-]+)\s*:\s*([^;{}]+);/gi, (all, lead, prop, value) => {
    const name = prop.toLowerCase();
    let next = value.trim();
    if (name === 'font-size' && FS[next]) { next = FS[next]; stats.decl++; }
    else if (['gap', 'row-gap', 'column-gap'].includes(name)) {
      const m = mapWords(next, SP); if (m) { next = m.value; stats.decl++; }
    } else if (['padding', 'margin'].includes(name)) {
      const m = mapWords(next, SP); if (m) { next = m.value; stats.decl++; }
    } else if (name === 'border-radius' && RAD[next]) { next = RAD[next]; stats.decl++; }
    else if (name === 'transition') {
      next = next.replace(/(^|\s)(120ms|180ms)(?=\s|,|$)/g, (x, pre, d) => { stats.decl++; return pre + (d === '120ms' ? 'var(--dur-1)' : 'var(--dur-2)'); });
    }
    // 颜色只换独立出现的字面量（避免碰 #ffffff 前缀与透明色）
    for (const [hex, tok] of Object.entries(COLORS)) {
      const re = new RegExp('(^|[\\s,(])' + hex + '(?=($|[\\s,);]))', 'gi');
      next = next.replace(re, (x, pre) => { stats.color++; return pre + tok; });
    }
    return lead + prop + ': ' + next + ';';
  });
  fs.writeFileSync(p, s);
  console.log('✓', f);
}
console.log(stats);
