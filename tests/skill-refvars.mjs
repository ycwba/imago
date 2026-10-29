#!/usr/bin/env node
/* 「项目引用规则」= **Skill 正文里的变量占位符**（`{cast}` `{what}` `{board}` …）：
   程序在发请求前按当前项目把实际内容填进去。
   这一族判据全在 web/domain/gen-forms.js 的 `window.TplVars` 与
   web/director/board-vars.js 的 `createBoardVars`。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();

/* TplVars 是经典脚本（挂 window.TplVars）—— 按 tests/local-first.cjs 那一套在 vm 里加载。 */
function bootTplVars() {
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Number, String, Object, Array,
    Map, Set, WeakMap, URL, URLSearchParams, RegExp, Error,
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  /* gen-forms.js 顶部还有别的面（ModelPrefs 等），它们在求值期不碰浏览器对象 ——
     只把 TplVars 那一段取出来跑，避免为测一个纯函数而起整个页面。 */
  const src = fs.readFileSync(path.join(root, 'web/domain/gen-forms.js'), 'utf8');
  const at = src.indexOf('window.TplVars = {');
  const end = src.indexOf('\n};', at) + 3;
  assert.ok(at > 0 && end > at, 'gen-forms.js 里应当找得到 TplVars 那一段');
  vm.runInContext(src.slice(at, end), ctx, { filename: 'gen-forms.js#TplVars' });
  return ctx.TplVars;
}

const TV = bootTplVars();

/* ① 填得上就填。 */
assert.equal(TV.fill('本集角色：\n{cast}\n结束', { cast: '- 小雅（角色）' }),
  '本集角色：\n- 小雅（角色）\n结束');

/* ② 填不上的**原样留着** —— 留空会让 AI 以为「这一段没有内容」，
   而原样留着它至少知道那是个待补的位子。 */
assert.equal(TV.fill('这一段要拆的是：{what}', { cast: 'x' }),
  '这一段要拆的是：{what}', '填不上的变量要原样留着');
assert.equal(TV.fill('{a}{b}', { a: '甲' }), '甲{b}', '只填给了值的那个');

/* ③ 变量名清单（设置页「项目引用规则」那一栏列的就是它）。
   ⚠ `TplVars` 是在 vm 的另一个 realm 里跑的，它返回的数组原型与这里不同 ——
   `deepStrictEqual` 会因为原型不同判不相等，所以先摊成一份本 realm 的数组。 */
const namesOf = s => [...TV.names(s)];
assert.deepEqual(namesOf('本集角色：{cast}\n外貌：{look}\n再提一次 {cast}'), ['cast', 'look'],
  '变量名要去重、按出现顺序');
assert.deepEqual(namesOf('没有变量'), []);
assert.deepEqual(namesOf(''), []);

/* ④ 不误伤正文里的普通花括号（JSON 片段之类）。 */
assert.equal(TV.fill('格式：{"a":1}', { a: 'X' }), '格式：{"a":1}',
  '只认 {单词}，不认 {"a":1} 这种 JSON');

/* ⑤ 导演台那一族的料（board-vars.js）：变量表与名单怎么拼。 */
const { createBoardVars } = await import('../web/director/board-vars.js');
const BV = createBoardVars({
  nameKey: s => String(s || '').trim().toLowerCase(),
  kindZhOf: x => (x.kind === 'scene' ? '场景' : (x.kind === 'prop' ? '物品' : '角色')),
});
{
  /* 角色表：名字 + 外貌 + 音色（AI 要靠它把人物前后写一致）。 */
  const cast = BV.castOf([
    { name: '小雅', kind: 'actor', look: '短发少女，灰色卫衣', voiceNote: '年轻女声，清亮偏慢' },
    { name: '河岸', kind: 'scene', desc: '黄昏的河岸，有石桥' },
    { name: '旧伞', kind: 'prop', look: '木质长柄伞，漆面斑驳' },
  ]);
  assert.match(cast, /- 小雅（角色 · 短发少女，灰色卫衣 · 音色：年轻女声，清亮偏慢）/);
  assert.match(cast, /- 河岸（场景 · 黄昏的河岸，有石桥）/);
  assert.match(cast, /- 旧伞（物品 · 木质长柄伞，漆面斑驳）/);
  /* 场景与物品**不写音色**（它们没有嗓子）—— 小雅那行有、那两行没有。 */
  const lines = cast.split('\n');
  assert.doesNotMatch(lines.find(l => l.includes('河岸')) || '', /音色/, '场景不该有音色');
  assert.doesNotMatch(lines.find(l => l.includes('旧伞')) || '', /音色/, '物品不该有音色');

  /* 选中的素材：名字写成 @引用（那是给生成模型的引用，不是 @ 变量）。 */
  const assets = BV.assetsOf([{ name: '小雅', look: '短发少女' }], x => x.look);
  assert.equal(assets, '- @小雅：短发少女');

  /* 变量表：缺的那一项是空串（于是 `TplVars.fill` 把它原样留着）。 */
  const v = BV.vars({ what: '一段剧本', cast: '名单' });
  assert.equal(v.what, '一段剧本');
  assert.equal(v.cast, '名单');
  assert.equal(v.board, '', '没给 board 就是空串');
  assert.equal(TV.fill('清单：{board}', v), '清单：{board}', '空的变量原样留着');
}

/* ⑥ 内置 Skill 的正文里确实写了变量（写错变量名就白填了）。 */
for (const [file, want] of [
  ['skills/split-script/SKILL.md', ['cast', 'assets', 'what', 'board', 'dur']],
  ['skills/board-edit/SKILL.md', ['board', 'cast', 'assets', 'what', 'dur']],
  ['skills/board-assets/SKILL.md', ['board', 'cast', 'assets']],
  ['skills/video-prompt/SKILL.md', ['duration', 'mode', 'model', 'ar', 'assets']],
  ['skills/image-prompt/SKILL.md', ['model', 'ar', 'assets']],
]) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const names = TV.names(text);
  for (const w of want) {
    assert.ok(names.includes(w), file + ' 里应当有 {' + w + '} 变量（现在有：' + names.join(',') + '）');
  }
}

console.log('✓ 项目引用规则：变量填料 / 填不上原样留着 / 变量清单 / 导演台的料 / 内置 Skill 写对了变量');
