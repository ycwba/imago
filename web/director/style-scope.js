/* 把模板样式的每条选择器挂到 `.director-page` 下 —— 作用域岛的那一层隔离。
   以前这里用 `@scope (.director-page) { … }` 整块圈住：浏览器认，但强制夜间模式这类扩展
   （按 CSSOM 规则类型逐条改写）不认 @scope —— 整块规则被跳过，页面底色变暗、栏与底栏
   仍是白的（那些 `background: var(--panel)` 在 @scope 里，扩展一条都没看见）。
   改成在文本上给选择器逐个加前缀：规则类型仍是普通样式规则，扩展与浏览器按同一套口径读。

   前缀写成 `:where(root)` 而不是 `root`：@scope 不把作用域根的权重加进内部选择器，
   :where 的权重是 0，换过来之后每一条的层叠顺序与换之前逐个相同。
   例：模板的 `.page-main` 仍输给 spa-director.css 的 `.director-page .page-main`
   （宿主负责滚动）；直接写 `.director-page .page-main` 会把这层让位翻过来。
   `:root` / `body` 这类本来就不在根里的选择器照旧不命中，行为与 @scope 一致。

   只递归分组规则（@media / @supports / @container / @layer）；@keyframes 的
   0% / from / to 不是选择器，其余 at-rule 原样抄过去。 */

const GROUPING = new Set(['media', 'supports', 'container', 'layer']);

export function scopeCss(css, root) {
  return scopeBlock(String(css), ':where(' + root + ')');
}

function skipString(css, i) {
  const quote = css[i++];
  while (i < css.length) {
    if (css[i] === '\\') { i += 2; continue; }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/* 找这一层里的下一个 `{` / `;` / `}`（跳过注释、字符串、括号与方括号里的那些）。 */
function nextStop(css, i) {
  let paren = 0, bracket = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") { i = skipString(css, i); continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (!paren && !bracket && (ch === '{' || ch === ';' || ch === '}')) return { at: i, ch };
    i++;
  }
  return { at: css.length, ch: '' };
}

/* i 是 `{` 之后那一位；返回块内正文与 `}` 之后那一位。 */
function readBlock(css, i) {
  const start = i;
  let depth = 1;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") { i = skipString(css, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (!depth) return { body: css.slice(start, i), next: i + 1 };
    }
    i++;
  }
  return { body: css.slice(start), next: css.length };
}

/* 选择器列表按顶层逗号拆开（`:is(a, b)` / `[title="a,b"]` 里的逗号不动）。 */
function splitSelectors(text) {
  const parts = [];
  let start = 0, paren = 0, bracket = 0, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") { i = skipString(text, i); continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (!paren && !bracket && ch === ',') { parts.push(text.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(text.slice(start));
  return parts;
}

function prefixSelectors(text, prefix) {
  const lead = /^\s*/.exec(text)[0];
  const trail = /\s*$/.exec(text)[0];
  const core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  return lead + splitSelectors(core).map(s => prefix + ' ' + s.trim()).join(', ') + trail;
}

/* 规则前面常挂一段注释；判断「这是不是 at-rule」要先把空白与注释剥掉，
   否则 `/* … *\/ @media …` 会被当成选择器去加前缀（整条 @media 连同里面的规则一起失效）。 */
function atRuleName(text) {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return '';
      i = end + 2;
      continue;
    }
    break;
  }
  const at = /^@([\w-]+)/.exec(text.slice(i));
  return at ? at[1].toLowerCase() : '';
}

function scopeBlock(css, prefix) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const start = i;
    const stop = nextStop(css, i);
    if (!stop.ch) { out += css.slice(start); break; }
    if (stop.ch === ';') { out += css.slice(start, stop.at + 1); i = stop.at + 1; continue; }
    if (stop.ch === '}') { out += css.slice(start, stop.at + 1); i = stop.at + 1; continue; }
    const prelude = css.slice(start, stop.at);
    const { body, next } = readBlock(css, stop.at + 1);
    const name = atRuleName(prelude);
    if (!name) out += prefixSelectors(prelude, prefix) + '{' + body + '}';
    else if (GROUPING.has(name)) out += prelude + '{' + scopeBlock(body, prefix) + '}';
    else out += prelude + '{' + body + '}';
    i = next;
  }
  return out;
}
