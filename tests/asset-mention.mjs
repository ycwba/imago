#!/usr/bin/env node
/* @素材的纯件（工作台与导演台共用 web/ui/asset-mention.js）：
   ① 正在打 @ 的判定（邮箱 / 中文紧邻 / 空白截断 / 选中一段时不弹）；
   ② 插入 token 的位置与补空格；range 给了就替换掉那一段；
   ③ 素材库一条的 token 写法（名字 / 名字·资产名）；
   ④ 这一条素材有哪几张图：预览图在前、角色资产在后、同一张不重复。 */
import assert from 'node:assert/strict';
import { mentionAt, insertToken, libraryTokenOf, libraryPicChoices } from '../web/ui/asset-mention.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const ta = (value, start, end) => ({ value, selectionStart: start, selectionEnd: end == null ? start : end, ownerDocument: { activeElement: null } });

/* ---- ① 正在打 @ ---- */
ok(mentionAt(ta('一个女孩站在@小雅旁边', 9)).q === '小雅', '中文紧挨着 @ 也要弹（中文句子不打空格）');
ok(mentionAt(ta('写 a@b.com 这种邮箱', 8)) === null, '@ 前面是字母数字不弹（邮箱）');
ok(mentionAt(ta('@小雅 站在门口', 3)).q === '小雅', '光标在 @片段 末尾时 q 是整段名字');
ok(mentionAt(ta('@小雅 站在门口', 6)) === null, '@ 后面有空白就不算正在打');
ok(mentionAt(ta('@小雅', 1, 3)) === null, '选中一段文字时不弹');
ok(mentionAt(ta('这是一句没有引用的话', 10)) === null, '没有 @ 不弹');

/* ---- ② 插入 ---- */
const t1 = ta('一个女孩', 4);
const c1 = insertToken(t1, '@小雅', null);
ok(t1.value === '一个女孩 @小雅 ' && c1 === t1.value.length, '接着中文插要补空格，光标落在 token 之后');
const t2 = ta('一个  ', 3);
insertToken(t2, '@小雅', null);
ok(t2.value === '一个 @小雅  ', '光标在原位置插入，后面的字保留');
const t3 = ta('一个@小', 1);
const c3 = insertToken(t3, '@小雅', { start: 2, end: 4 });
ok(t3.value === '一个 @小雅 ' && c3 === 7, 'range 给了就替换掉 `@` 到光标那一段');
const t4 = ta('已有内容', 0);
insertToken(t4, '@参考图1', null);
ok(t4.value === '已有内容 @参考图1 ', '输入框从没聚焦过（0/0）时接在末尾');

/* ---- ③ token 写法 ---- */
ok(libraryTokenOf('小雅', '') === '小雅', '用预览图时 token 就是素材名');
ok(libraryTokenOf('小雅', '三视图') === '小雅·三视图', '挑角色资产时写成「名字·资产名」');

/* ---- ④ 一条素材有哪几张图 ---- */
globalThis.window = {
  Chars: {
    refPicOf: x => x.anchor || x.face || '',
    picOf: x => x.face || '',
    Cast: { assetsOf: x => x.assets || [], assetName: a => a.name },
  },
};
const entry = { name: '小雅', anchor: 'a.png', face: 'f.png', assets: [{ src: 'x.png', name: '三视图' }, { src: 'a.png', name: '重复的锚点' }] };
const choices = libraryPicChoices(entry);
ok(choices[0].src === 'a.png' && choices[0].tag === '身份锚点', '身份锚点排第一');
ok(choices.some(x => x.src === 'f.png' && x.note === ''), '预览图不是锚点时也列出来');
ok(choices.some(x => x.src === 'x.png' && x.note === '三视图'), '角色资产带自己的名字');
ok(choices.filter(x => x.src === 'a.png').length === 1, '锚点就是那张资产时不重复列');
ok(libraryPicChoices({ name: '空的', assets: [] }).length === 0, '一张图都没有时返回空');

console.log('@素材纯件：' + n + ' 条断言通过');
