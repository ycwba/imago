#!/usr/bin/env node
/* 台词那一档（web/director/lines.js）：说话人 → 素材库、本镜与全片两个时间读数、行渲染。
   全站只有剪辑右栏那一段用这份渲染（镜头编辑右栏那一份已删），所以判据只测这一份。 */
import assert from 'node:assert/strict';
import { speakerOf, lineTimeOf, lineRowHTML } from '../web/director/lines.js';

const lib = [
  { name: '林夏', anchor: 'a.png', face: 'f.png', img: 'i.png' },
  { name: '周岚', face: 'z.png', img: 'j.png' },
  { name: '顾川', img: 'g.png' },
];

assert.deepEqual(speakerOf('  林夏  ', lib), { name: '林夏', img: 'a.png', inLib: true, empty: false },
  '名字两边空白先收掉；图取 anchor 优先');
assert.deepEqual(speakerOf('周岚', lib), { name: '周岚', img: 'z.png', inLib: true, empty: false });
assert.deepEqual(speakerOf('顾川', lib), { name: '顾川', img: 'g.png', inLib: true, empty: false });
assert.deepEqual(speakerOf('路人甲', lib), { name: '路人甲', img: '', inLib: false, empty: false },
  '素材库没有也把名字原样带回来');
assert.deepEqual(speakerOf('', lib), { name: '', img: '', inLib: false, empty: true });
assert.equal(speakerOf('林夏', null).inLib, false, '素材库没加载也不崩');

/* 两个读数：各写各的前缀，算不出来的那一档直说没有，不拿 0 冒充起点。 */
const both = lineTimeOf({ shot: { at: 1.5, len: 2.5 }, film: { at: 3, len: 2 } });
assert.equal(both.shotText, '本镜 1.5–4 秒', '本镜那一排是本镜轴秒，一位小数');
assert.equal(both.filmText, '全片 3–5 秒');
assert.match(both.title, /长按字数估/);
assert.doesNotMatch(both.title, /没有可摆的位置/, '两排都算得出来时不写原因');
assert.equal(lineTimeOf({ shot: { at: 3.25, len: 2 }, film: null }).shotText, '本镜 3.3–5.3 秒');
const noFilm = lineTimeOf({ shot: { at: 0, len: 4 }, film: null });
assert.equal(noFilm.filmText, '全片 —');
assert.match(noFilm.title, /还没进成片/);
const noShot = lineTimeOf({ shot: null, film: { at: 6, len: 1 } });
assert.equal(noShot.shotText, '本镜 —');
assert.match(noShot.title, /还没有画面段/);
assert.equal(lineTimeOf({}).shotText, '本镜 —', '两条都没有时也照实写两个破折号');
assert.equal(lineTimeOf(null).filmText, '全片 —', '整个交空也不崩');

const o = { esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), icon: n => '[' + n + ']', mediaSrc: u => '/m/' + u };
const row = {
  sh: { id: 's1' }, no: 3, text: '你来了 <b>', who: '林"夏',
  speaker: speakerOf('林夏', lib), time: both, pending: true, mine: true,
};

const html = lineRowHTML(row, { ...o, clickHint: '点标题切过去' });
assert.match(html, /class="line-row edit on"/);
assert.match(html, /data-lineshot="s1"/);
assert.match(html, /<img src="\/m\/a.png"/, '说话人缩略图走 mediaSrc');
assert.match(html, /第 3 镜<\/span><span>本镜 1\.5–4 秒<\/span><span>全片 3–5 秒/,
  '镜号与本镜 / 全片两个读数排在同一格里');
assert.match(html, /<em class="pend">待生成<\/em>/);
assert.match(html, /data-line-text="s1"/);
assert.match(html, /class="ui-inp lr-name" data-line-who="s1"/, '说话的人只有名字这一件控件');
assert.doesNotMatch(html, /lr-who/, '重复的「谁说的」输入框已删');
assert.match(html, /你来了 &lt;b&gt;/, '台词要转义');
assert.match(html, /value="林&quot;夏"/, '说话人值要转义');
assert.match(html, /list="lineWhoList"/);
assert.match(html, /placeholder="说话的人"/);
assert.match(html, /点标题切过去/);

const out = lineRowHTML({ ...row, mine: false, pending: false, who: '', speaker: speakerOf('', lib), text: '嗯' }, o);
assert.doesNotMatch(out, /class="line-row edit on"/, '不是当前镜就没有 on');
assert.match(out, /<em class="done">已生成<\/em>/);
assert.match(out, /<span class="lr-ph">\[user\]<\/span>/, '没写说话人画占位图');
assert.match(out, /value=""[\s\S]*?placeholder="说话的人"/, '没写说话人时名字输入框留空');

const blankHTML = lineRowHTML({ ...row, text: '', pending: false, who: '', speaker: speakerOf('', lib) }, o);
assert.match(blankHTML, /<em class="none">未写<\/em>/, '没有字就是「未写」，不是「已生成」');
assert.match(blankHTML, /<span class="lr-ph">\[user\]<\/span>/, '没写说话人也留占位图');

console.log('✓ director-lines');
