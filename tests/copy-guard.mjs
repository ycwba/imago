#!/usr/bin/env node
/* 文案硬约束（G-文案）：组件本身应该体现功能，文案只补组件表达不了的。
   五条可机器判的规矩，违例当场点名：
     ① 已删的「组件外说明行」不许回归：comboScopeNote / modeHead 两个标识符，
        与「这一档收：」「放哪一批素材就是哪一种请求」「换模式只改」三句旧文案
        （组件外的重复说明 —— 素材磁贴自己写着「已有 N / max」，就是说明）。
     ② 点按指引不写在文案里：「点这里」「点击选择」这类可点击性提示已删 ——
        磁贴 / 按钮用光标与 hover 表达可点。
     ③ 素材磁贴的数量句必须来自声明：任何「已有 N / max」两头都是数字字面量的写法都算
        写死（N 现算、max 现读 sl.max / ic.maxRef / ic.roleMax —— 与提交拦截同一把尺）。
     ④ 渲染素材磁贴的两个文件（director 的 panel.js / 工作台 studio.js）非注释行不得出现
        写死的大小文案（「≤ … MB」进字符串）—— 大小只有 ruleText / fmtBytes 一份出处。
     ⑤ 不防御性描述：AGENTS.md 的「组件自述」条目必须直说「组件本身应该体现功能」，
        且不得出现防御性措辞（保留项 / 例外 / 只补后果语义 / 逐项列举例外）——
        规矩直说，不预先辩解。
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
/* ⑤ 不防御性描述：AGENTS.md 的「组件自述」条目直说规矩本身 —— 不列举实现细节、
   不预先辩解。条目里出现「数量 / 大小限制写在…」「档位收哪些素材」这类展开句，
   或「保留项 / 例外」这类防御性措辞，都算违例。 */
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').split(/\r?\n/);
const start = agents.findIndex(l => l.trim() === '- 组件本身应该体现功能；文案只补组件表达不了的。');
if (start < 0) {
  bad.push('AGENTS.md 缺「组件本身应该体现功能」那条直说（组件自述条目被改写或搬走）');
} else {
  const bullet = [agents[start]];
  for (let i = start + 1; i < agents.length; i++) {
    if (agents[i].startsWith('- ') || agents[i].startsWith('## ')) break;
    bullet.push(agents[i]);
  }
  const text = bullet.join('\n');
  const HEDGE = ['数量 / 大小限制', '档位收哪些素材', '单位 · 大小', '保留项', '例外',
    'icon-only', '阶段状态句', '对话框后果', '只补后果语义', 'title 只补'];
  HEDGE.forEach(h => { if (text.includes(h)) bad.push('AGENTS.md 组件自述条目过度防御性描述：「' + h + '」'); });
  for (const need of ['tests/copy-guard.mjs']) {
    if (!text.includes(need)) bad.push('AGENTS.md 组件自述条目缺硬约束指针：' + need);
  }
}
assert.deepEqual(bad, [], '文案硬约束违例 ' + bad.length + ' 处：\n' + bad.join('\n'));
console.log('✓ copy-guard：' + n + ' 个文件 · 说明行 / 点按指引 / 写死数量 / 写死大小 / 不防御性描述 五条全过');
