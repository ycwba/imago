#!/usr/bin/env node
'use strict';
/* 导演台导出格式只有一张表（web/domain/export-formats.js，报告 §6.2「新增导出格式要改 6-7 处」）。
   这份判据钉两件事：
     · 表本身完整：id / 按钮号唯一，kind 是 engine 认识的那三种，助手要读的文案字段都在；
     · 没有第二份：engine 不再写死格式数组、助手不再抄 enum / 文案表、模板不再手写导出按钮，
       三处都必须读 window.ExportFormats。
   加一种导出只改表；哪天又长出第二份清单，这里当场红。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let bad = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++;
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

const sandbox = { window: {} };
vm.runInNewContext(read('web/domain/export-formats.js'), sandbox);
const EF = sandbox.window.ExportFormats;
ok('表挂在 window.ExportFormats 上并给出读法', !!EF && ['list', 'ids', 'of', 'hint'].every(k => typeof EF[k] === 'function'));
if (!EF) process.exit(1);

const list = EF.list(), ids = EF.ids();
ok('五个导出格式都在（成片 / 素材 / FCPXML / 媒体包 / 送到 NLE）',
  JSON.stringify(ids) === JSON.stringify(['film', 'assets', 'fcpxml', 'bundle', 'nle']));
ok('id 与页头按钮号都不重复',
  new Set(ids).size === ids.length && new Set(list.map(f => f.button)).size === list.length);
ok('每条都有 engine 认识的 kind', list.every(f => ['film', 'files', 'xml'].includes(f.kind)),
  list.filter(f => !['film', 'files', 'xml'].includes(f.kind)).map(f => f.id).join(', '));
ok('每条都带页面与助手要的文案字段', list.every(f =>
  f.id && f.button && f.label && f.icon && f.title && f.assistant && f.doc && f.startNote));
ok('只有走 /render 的档给了取消文案', list.every(f => !f.renders || !!f.cancelLabel));
ok('表查询与写法一致（of / hint 不另算一遍）',
  list.every(f => EF.of(f.id) === f) && !EF.of('nope') && EF.hint() === ids.join(' / '));

/* 唯一来源：这三处只要再抄一份格式清单，就说明「加一种导出」又变成多处改。 */
const engine = read('web/director/engine.js');
/* §6.1-2 把动作表拆去 chat-tools.js：两半合起来才是「助手这一侧」 */
const chat = read('web/features/chat.js') + read('web/features/chat-tools.js');
const template = read('web/director/template.html');
ok('engine 不再写死格式数组', !/\[\s*'film',\s*'assets',\s*'fcpxml',\s*'bundle'\s*\]/.test(engine)
  && /ExportFormats\.of\(fmt\)/.test(engine) && /ExportFormats\.ids\(\)\[0\]/.test(engine));
ok('engine 的页头按钮与取消状态都表驱动',
  /ExportFormats\.list\(\)\.forEach/.test(engine) && /ExportFormats\.of\(r\.format\)/.test(engine)
  && /ExportFormats\.of\('assets'\)/.test(engine) && /ExportFormats\.of\('film'\)/.test(engine));
ok('助手不再另抄 enum 与标题表', !/enum:\s*\[\s*'film'/.test(chat)
  && /enum:\s*EF\.ids\(\)/.test(chat) && /EF\.of\(fmt\)/.test(chat) && /EF\.list\(\)\.map/.test(chat));
ok('模板不再手写导出按钮', /id="exportBtns"/.test(template) && !/id="exportFilm"/.test(template)
  && !/id="exportFcp(Bundle)?"/.test(template));
ok('助手与导演台都按需加载这张表', /web\/domain\/export-formats\.js/.test(read('web/boot-assistant.js'))
  && /web\/domain\/export-formats\.js/.test(read('web/director/index.js')));

console.log(bad ? `\n导出格式表判据：${bad}/${checks} 条红` : `\n导出格式表判据：${checks}/${checks} 全绿`);
process.exit(bad ? 1 : 0);
