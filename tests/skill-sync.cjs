#!/usr/bin/env node
/* Skill 正文副本由构建期生成（快档，不开浏览器）：
   ① TextAI.DEF 的每份正文 == skills/<id>/SKILL.md 的归一化正文，GLOSSARY == skills/_glossary.md；
   ② 9 份导演台 Skill 正文里有 {glossary}，defaultPrompt 会把同一份词汇表填进去；
   ③ 工具 rewrite 是幂等的（再生成一遍逐字节不变）。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tool = require('../tools/sync-skill-contracts.cjs');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

const src = read('web/domain/text-ai.js');
const bodies = tool.skillFiles();
const next = tool.rewriteSource(src, bodies, path.join(root, 'skills', '_glossary.md'));
ok(next === src, 'DEF 正文与 skills/*/SKILL.md 一致（改写一遍逐字节不变）');
ok(tool.rewriteSource(next, bodies, path.join(root, 'skills', '_glossary.md')) === next, '生成是幂等的');

const ctx = {
  window: {
    LS: { get: () => '' }, Store: { read: () => [], write: () => {} },
    Api: { errorMessage: () => 'err' },
    TplVars: { fill: (tpl, vals) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vals && vals[k];
      return (v == null || v === '') ? m : String(v);
    }) },
  },
  console,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const TextAI = ctx.window.TextAI;

const contractOf = file => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
  const hit = fm && /^contract:\s*(.+)$/m.exec(fm[1]);
  return hit ? hit[1].trim() : '';
};
const byContract = new Map();
for (const file of bodies.values()) byContract.set(contractOf(file), file);

let checked = 0;
for (const [key, contract] of Object.entries(TextAI.SKILL_CONTRACT)) {
  const file = byContract.get(contract);
  ok(!!file, 'contract「' + contract + '」有对应的 SKILL.md');
  ok(TextAI.DEF[key] === tool.normalized(file), key + ' 的内置副本与 ' + path.basename(path.dirname(file)) + '/SKILL.md 逐字节相同');
  checked += 1;
}
ok(checked === 14, '14 份 Skill 正文全部对上：' + checked);
ok(TextAI.GLOSSARY === tool.normalized(path.join(root, 'skills', '_glossary.md')), 'GLOSSARY 与 skills/_glossary.md 一致');
ok(TextAI.GLOSSARY.includes('**镜头（shot）**') && TextAI.GLOSSARY.includes('**草稿（draft）**'), '词汇表覆盖镜头 / 草稿等术语');

const nine = ['board_assets', 'board_edit', 'line_write', 'split_follow', 'split', 'story', 'video', 'img', 'audio'];
for (const key of nine) {
  ok(TextAI.DEF[key].includes('{glossary}'), key + ' 的正文里有 {glossary}');
  const filled = TextAI.defaultPrompt(key, false, {});
  ok(filled.includes('**镜头（shot）**') && filled !== TextAI.DEF[key], key + ' 的默认指令把词汇表填进去了');
}

console.log('✓ skill-sync：' + n + ' 项通过');
