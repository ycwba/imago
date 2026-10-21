#!/usr/bin/env node
/* 剧本视图（web/director/script.js）：分镜 → 稿子 → 同一批镜头的 `sh.prompt`。
   稿子里只有画面：台词另有自己的面板，改提示词不该连着改台词。 */
import assert from 'node:assert/strict';
import { scriptTextOf, parseScript, applyScript } from '../web/director/script.js';

const mk = () => ([
  { name: '河岸', shots: [
    { id: 's1', name: '开场', prompt: '河边，傍晚', line: '你来了', lineWho: '林夏' },
    { id: 's2', name: '', prompt: '远景', line: '', lineWho: '' },
  ] },
  { name: '', shots: [
    { id: 's3', name: '回头', prompt: '她回头\n一直在看你', line: '嗯', lineWho: '周岚' },
  ] },
]);

/* ---------- 写出：全片连续镜头号 + 只有「画面」一项 + 续行缩进 ---------- */
const text = scriptTextOf(mk());
assert.equal(text, [
  '# 场景 1 · 河岸',
  '## 镜头 1 · 开场',
  '画面：河边，傍晚',
  '',
  '## 镜头 2',
  '画面：远景',
  '',
  '# 场景 2',
  '## 镜头 3 · 回头',
  '画面：她回头',
  '  一直在看你',
  '',
].join('\n'), '镜头号跨场景连续；多行画面续行缩进两个空格');
assert.doesNotMatch(text, /台词|说话人/, '稿子里不出现台词与说话人（那两份数据各有各的面板）');
assert.equal(scriptTextOf([]), '', '没有场景时是空稿');

/* ---------- 解析：场景行只分组，字段认全角 / 半角冒号 ---------- */
const parsed = parseScript(text);
assert.equal(parsed.blocks.length, 3);
assert.deepEqual(parsed.blocks.map(b => b.n), [1, 2, 3]);
assert.deepEqual(parsed.blocks[2].fields, { prompt: '她回头\n一直在看你' }, '续行要接回同一段画面');
assert.equal(parseScript('## 镜头 1\n画面:半角冒号').blocks[0].fields.prompt, '半角冒号');
assert.equal(parseScript('随手一段没有镜头号的文字\n画面：不算').blocks.length, 0,
  '没有 ## 镜头 N 的段落不参与写回');
assert.equal(parseScript('## 镜头 0\n画面：x\n## 镜头 abc\n画面：y').blocks.length, 0,
  '镜头号必须是正整数');
assert.deepEqual(parseScript('## 镜头 1\n画面：a\n台词：b\n说话人：c').blocks[0].fields, { prompt: 'a' },
  '稿子里写着台词 / 说话人也不认：这两项不是这一档的字段');

/* ---------- 原样往返：一个字都不改 ---------- */
const scenes = mk();
const same = applyScript(scenes, parseScript(text));
assert.equal(same.upd, 0, '原稿往返不该产生改动');
assert.equal(same.blocks, 3);
assert.equal(same.skipped, 0);
assert.equal(scenes[0].shots[0].line, '你来了');

/* ---------- 改稿 → 镜头：只写画面，台词与说话人一个字不动 ---------- */
const scenes2 = mk();
const r2 = applyScript(scenes2, parseScript([
  '## 镜头 1 · 开场',
  '画面：河边，清晨',
  '## 镜头 2',
  '画面：',
  '## 镜头 9',
  '画面：对不上的一镜',
].join('\n')));
assert.equal(r2.promptUpd, 2);
assert.equal(r2.upd, 2);
assert.equal(r2.skipped, 1, '分镜里没有的镜头号要报数，不静默丢');
assert.equal(scenes2[0].shots[0].prompt, '河边，清晨');
assert.equal(scenes2[0].shots[1].prompt, '', '「画面：」留空就是清空这一段描述');
assert.equal(scenes2[0].shots[0].line, '你来了', '改画面不动台词');
assert.equal(scenes2[0].shots[0].lineWho, '林夏', '改画面不动说话人');
assert.equal(scenes2[1].shots[0].prompt, '她回头\n一直在看你', '没出现在稿子里的镜头一个字不动');
assert.deepEqual(Object.keys(r2).sort(), ['blocks', 'promptUpd', 'skipped', 'total', 'upd'],
  '计数里不再有台词那一族');

/* ---------- 重复的镜头号只认第一次 ---------- */
const scenes3 = mk();
const r3 = applyScript(scenes3, parseScript('## 镜头 1\n画面：第一次\n## 镜头 1\n画面：第二次\n'));
assert.equal(r3.promptUpd, 1);
assert.equal(r3.skipped, 1);
assert.equal(scenes3[0].shots[0].prompt, '第一次');

console.log('✓ director-script');
