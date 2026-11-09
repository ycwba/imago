#!/usr/bin/env node
/* 把 TextAI.DEF 里的 Skill 正文副本与 GLOSSARY 从磁盘上的 Skill 文件重新生成。
   为什么要工具：正文有两份（skills/<id>/SKILL.md 是用户可改的真源，text-ai.js 的 DEF 是
   没加载到 Skill 时的退回副本），手抄 14 份逐字节相同的正文迟早漂。这个工具只替换
   `key: <值>` 的值部分，键与注释一个都不动。

   用法：
     node tools/sync-skill-contracts.cjs           按 skills/ 重写 text-ai.js（构建期）
     node tools/sync-skill-contracts.cjs --check   只比对，不一致就红（CI / 判据）
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT = path.join(ROOT, 'web', 'domain', 'text-ai.js');
const SKILLS = path.join(ROOT, 'skills');
const GLOSSARY_FILE = path.join(SKILLS, '_glossary.md');
const CHECK = process.argv.includes('--check');

/* 与 TextAI.skillBody 同一套归一：去掉 BOM / frontmatter / 第一个标题行 / CRLF / 尾空白。 */
function normalized(file) {
  let s = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  s = s.replace(/^---\n[\s\S]*?\n---\n/, '');
  s = s.replace(/^\s*#\s+[^\n]*\n+/, '');
  return s.replace(/^\n+/, '').replace(/\s+$/, '');
}

function asTemplate(s) {
  return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

function contractsOf(src) {
  const m = /SKILL_CONTRACT:\s*\{([\s\S]*?)\n  \},/.exec(src);
  if (!m) throw new Error('text-ai.js 里找不到 SKILL_CONTRACT');
  const out = [];
  const re = /([a-z][a-z0-9_]*):\s*'([^']+)'/g;
  let hit;
  while ((hit = re.exec(m[1]))) out.push([hit[1], hit[2]]);
  return out;
}

function skillFiles() {
  const map = new Map();
  for (const ent of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const md = path.join(SKILLS, ent.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    const text = fs.readFileSync(md, 'utf8').replace(/^\uFEFF/, '');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
    const contract = fm && /^contract:\s*(.+)$/m.exec(fm[1]);
    if (!contract) continue;
    map.set(contract[1].trim(), md);
  }
  return map;
}

/* 找到 `key: ` 之后那个值（模板字面量或 '...' + '...' 拼接）的起止。
   返回 [值起点, 值终点)；逗号留在原处。 */
function valueSpan(src, from) {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  const start = i;
  for (;;) {
    if (src[i] === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        i++;
      }
    } else if (src[i] === "'") {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
    } else {
      throw new Error('第 ' + start + ' 个字符起不是字符串值：' + JSON.stringify(src.slice(start, start + 40)));
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '+') { i++; while (i < src.length && /\s/.test(src[i])) i++; continue; }
    break;
  }
  return [start, i];
}

function rewriteSource(src, bodies, glossary) {
  const defAt = src.indexOf('DEF: {');
  if (defAt < 0) throw new Error('text-ai.js 里找不到 DEF');
  const defEnd = src.indexOf('\n  },', defAt);
  if (defEnd < 0) throw new Error('DEF 没有闭合');
  const edits = [];
  for (const [key, contract] of contractsOf(src)) {
    const file = bodies.get(contract);
    if (!file) throw new Error('找不到 contract「' + contract + '」对应的 SKILL.md');
    const keyAt = src.indexOf('\n    ' + key + ': ', defAt);
    if (keyAt < 0 || keyAt > defEnd) throw new Error('DEF 里找不到条目：' + key);
    const colon = src.indexOf(': ', keyAt) + 2;
    const [vs, ve] = valueSpan(src, colon);
    edits.push([vs, ve, asTemplate(normalized(file))]);
  }
  const gAt = src.indexOf('\n  GLOSSARY: ', defEnd);
  if (gAt < 0) throw new Error('text-ai.js 里找不到 GLOSSARY');
  if (!fs.existsSync(GLOSSARY_FILE)) throw new Error('缺少 skills/_glossary.md');
  {
    const colon = src.indexOf(': ', gAt) + 2;
    const [vs, ve] = valueSpan(src, colon);
    edits.push([vs, ve, asTemplate(normalized(GLOSSARY_FILE))]);
  }
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [vs, ve, text] of edits) out = out.slice(0, vs) + text + out.slice(ve);
  return out;
}

function runSync() {
  const src = fs.readFileSync(TEXT, 'utf8');
  const bodies = skillFiles();
  const next = rewriteSource(src, bodies, GLOSSARY_FILE);
  if (CHECK) {
    if (next === src) {
      console.log('✓ Skill 正文副本与 skills/*/SKILL.md 一致（' + bodies.size + ' 份 + 词汇表）');
      return;
    }
    const a = src.split('\n');
    const b = next.split('\n');
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        diff += 1;
        if (diff <= 5) console.log('  ✗ 第 ' + (i + 1) + ' 行不一致：' + String(a[i]).slice(0, 80));
      }
    }
    console.error('✗ text-ai.js 的 Skill 副本漂了（' + diff + ' 行）：跑 node tools/sync-skill-contracts.cjs 重新生成');
    process.exit(1);
  }
  fs.writeFileSync(TEXT, next);
  console.log('✓ 已从 skills/ 重写 TextAI.DEF 的 ' + bodies.size + ' 份正文与 GLOSSARY');
}

if (require.main === module) runSync();

module.exports = { normalized, rewriteSource, skillFiles, contractsOf };
