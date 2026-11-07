#!/usr/bin/env node
/* 导演台模板样式的挂根规则：每条选择器都要落在 `.director-page` 下，且前缀零权重。
   这一层以前是 `@scope (.director-page)`：浏览器认，强制夜间模式这类按 CSSOM 规则类型
   逐条改写的扩展不认 —— 整块样式被跳过，页面底色变暗、左右栏与底栏仍是白的。
   判据钉四件事：
     ① 普通规则逐条加 `:where(.director-page)`（列表拆开、括号与属性值里的逗号不动）；
     ② 前缀是 :where（零权重）—— 写成普通类名会让模板的 `.page-main` 翻过来压过
        spa-director.css 的宿主滚动规则；
     ③ @media / @supports / @container / @layer 里递归，@keyframes 的 0% / from / to 不碰；
     ④ 真实模板整份转一遍：没有 @scope 残留、规则数与选择器前缀数对得上、大括号配平。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeCss } from '../web/director/style-scope.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = ':where(.director-page)';

function main() {
  /* 普通规则：选择器列表逐个加前缀，括号 / 属性值里的逗号不拆。 */
  assert.equal(
    scopeCss('.col, .row:hover { color: var(--txt); }', '.director-page'),
    P + ' .col, ' + P + ' .row:hover { color: var(--txt); }');
  assert.equal(
    scopeCss('[title="a,b"] , :is(.x, .y) > .z { top: 0 }', '.director-page'),
    P + ' [title="a,b"], ' + P + ' :is(.x, .y) > .z { top: 0 }');

  /* 前缀是 :where：零权重，选择器本体一位不动。 */
  assert.ok(scopeCss('.page-main { height: 100vh }', '.director-page').startsWith(P + ' .page-main {'));

  /* 分组规则递归；@keyframes 与其余 at-rule 原样抄，帧名不挂前缀。 */
  const grouped = scopeCss(
    '@media (max-width: 760px) { .a { top: 0 } @supports (display: grid) { .b { top: 1px } } }',
    '.director-page');
  assert.equal(grouped,
    '@media (max-width: 760px) { ' + P + ' .a { top: 0 } @supports (display: grid) { ' + P + ' .b { top: 1px } } }');
  assert.equal(
    scopeCss('@keyframes k { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }', '.director-page'),
    '@keyframes k { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }');
  assert.equal(scopeCss('@import url("x.css");', '.director-page'), '@import url("x.css");');

  /* 注释、字符串里的大括号与分号不参与分层（前缀落在选择器最前，注释夹在两者之间不改变命中的元素）。 */
  assert.equal(
    scopeCss('/* a{b;c} */ .x::after { content: "}{;" }', '.director-page'),
    P + ' /* a{b;c} */ .x::after { content: "}{;" }');

  /* 真实模板：整份转一遍。 */
  const html = fs.readFileSync(path.join(root, 'web/director/template.html'), 'utf8');
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(m, '模板里没有 <style> 块');
  const src = m[1];
  const out = scopeCss(src, '.director-page');
  assert.ok(!/@scope/.test(out), '输出里还有 @scope');
  assert.ok(!out.includes('@scope'), '输出里还有 @scope 文本');

  const top = topRules(out);
  const styles = top.filter(r => !r.at);
  assert.ok(styles.length > 500, '转出来的普通规则只有 ' + styles.length + ' 条（模板应有数百条）');
  const bad = styles.filter(r => !r.pre.startsWith(P));
  assert.equal(bad.length, 0, '没挂上前缀的规则：' + bad.slice(0, 3).map(r => r.pre).join(' ｜ '));
  /* 每个选择器只加一次前缀：`.col, .row` 两段各有、没有 `.director-page .director-page`。 */
  assert.ok(!out.includes(P + ' ' + P), '选择器被加了两次前缀');

  /* 已知落点：左右栏的卡面底色进了前缀，扩展才看得见 background: var(--panel)。 */
  assert.match(out, new RegExp(escapeRe(P) + ' \\.col \\{[^}]*background: var\\(--panel\\)'));
  /* 媒体查询里的规则同样挂前缀。 */
  const media = top.filter(r => r.at && /^@media/.test(r.name));
  assert.ok(media.length >= 6, '模板的媒体查询条数对不上：' + media.length);
  for (const g of media) {
    const inner = topRules(g.body).filter(r => !r.at);
    assert.ok(inner.length > 0, g.name + ' 里没有规则');
    assert.ok(inner.every(r => r.pre.startsWith(P)), g.name + ' 里有没挂前缀的规则');
  }
  /* 关键帧：@keyframes 里的 from / to / 50% 不是选择器。 */
  const kf = top.filter(r => r.at && /^@keyframes/.test(r.name));
  assert.ok(kf.length >= 2, '模板的关键帧条数对不上：' + kf.length);
  assert.ok(kf.every(r => !r.body.includes(P)), '关键帧里的帧名被加上了前缀');
  assert.equal(braces(out), braces(src), '转完之后大括号数变了');

  console.log('director-style-scope: ok（模板 ' + styles.length + ' 条普通规则全部挂到 :where(.director-page) 下，'
    + media.length + ' 组媒体查询递归，' + kf.length + ' 段关键帧原样）');
}

/* 顶层规则扫描：只为判据服务，够用即可（跳过注释 / 字符串 / 括号）。 */
function topRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const start = i;
    let paren = 0, bracket = 0, stop = -1;
    while (i < css.length) {
      const ch = css[i];
      if (ch === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }
      if (ch === '"' || ch === "'") {
        const q = ch; i++;
        while (i < css.length && css[i] !== q) i += css[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (!paren && !bracket && ch === '{') { stop = i; break; }
      i++;
    }
    if (stop < 0) break;
    const pre = stripComments(css.slice(start, stop)).trim();
    let depth = 1, j = stop + 1;
    const bodyStart = j;
    while (j < css.length && depth) {
      const ch = css[j];
      if (ch === '/' && css[j + 1] === '*') { const e = css.indexOf('*/', j + 2); j = e < 0 ? css.length : e + 2; continue; }
      if (ch === '"' || ch === "'") {
        const q = ch; j++;
        while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
        j++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const name = /^@([\w-]+)/.exec(pre);
    rules.push({ at: !!name, name: name ? name[0] : '', pre, body: css.slice(bodyStart, j - 1) });
    i = j;
  }
  return rules;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const braces = s => (s.match(/[{}]/g) || []).length;
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

try { main(); }
catch (e) { console.error(e && e.stack || e); process.exit(1); }
