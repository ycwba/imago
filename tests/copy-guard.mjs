#!/usr/bin/env node
/* 文案硬约束（G-文案）：让组件本身体现功能，说明句只留组件表达不了的功能语义。
   四条可机器判的规矩，违例当场点名：
     ① 已删的「组件外说明行」不许回归：comboScopeNote / modeHead 两个标识符，
        与「这一档收：」「放哪一批素材就是哪一种请求」「换模式只改」三句旧文案
        （组件外的重复说明 —— 素材磁贴自己写着「已有 N / max」，就是说明）。
     ② 点按指引不写在文案里：「点这里」「点击选择」这类可点击性提示已删 ——
        磁贴 / 按钮用光标与 hover 表达可点（title 里补充后果语义不受限）。
     ③ 素材磁贴的数量句必须来自声明：任何「已有 N / max」两头都是数字字面量的写法都算
        写死（N 现算、max 现读 sl.max / ic.maxRef / ic.roleMax —— 与提交拦截同一把尺）。
     ④ 渲染素材磁贴的两个文件（director 的 panel.js / 工作台 studio.js）非注释行不得出现
        写死的大小文案（「≤ … MB」进字符串）—— 大小只有 ruleText / fmtBytes 一份出处。
   存量表只减不增：本判据没有存量 —— 命中就是新增，直接红。 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:js|mjs|cjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [
  ...walk(path.join(root, 'web'), []),
  ...walk(path.join(root, 'tools', 'vue-templates'), []),
];
const rel = p => path.relative(root, p).replace(/\\/g, '/');

/* ① 已删的说明行 / 点按指引：整个 web 层（含注释）都不该再出现 —— 注释只写当前事实。 */
const BANNED = [
  'comboScopeNote', 'modeHead',
  '放哪一批素材就是哪一种请求', '这一档收：', '换模式只改', '点这里', '点击选择',
];
/* ② 数量句两头写死：`已有 3 / 9`（max 不来自声明）。动态的 `已有 ${n} / ${max}` 与
   `已有 0 / ${roleMax(...)}`（空槽的 0 是常量、max 是现读）都放行。 */
const COUNT_LIT = /已有\s*\d+\s*\/\s*\d+/;
/* ③ 大小文案写死进磁贴渲染层：非注释行里「≤ … MB」进了字符串。 */
const SIZE_LIT = /(['"`])[^'"`]*≤[^'"`]*MB/;

const SLOT_FILES = ['web/director/engine/panel.js', 'web/pages/studio.js'];
const isCommentLine = line => {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('/*') || t.startsWith('//');
};

let n = 0;
const bad = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const s of BANNED) {
      if (line.includes(s)) bad.push(rel(f) + ':' + (i + 1) + ' 已删说明句/标识符回归：「' + s + '」');
    }
  });
  if (COUNT_LIT.test(src)) bad.push(rel(f) + ' 数量句两头写死（已有 N / max 应现读声明）');
  if (SLOT_FILES.includes(rel(f))) {
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (SIZE_LIT.test(line)) bad.push(rel(f) + ':' + (i + 1) + ' 大小文案写死进磁贴（用 slotNote / ruleText）');
    });
  }
  n++;
}
assert.deepEqual(bad, [], '文案硬约束违例 ' + bad.length + ' 处：\n' + bad.join('\n'));
console.log('✓ copy-guard：' + n + ' 个文件 · 说明行 / 点按指引 / 写死数量 / 写死大小 四条全过');
