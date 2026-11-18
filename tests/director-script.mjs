#!/usr/bin/env node
/* 剧本视图（web/director/script.js）：分镜 → 稿子 → 同一批候选各自的描述。
   「画面」那一层已经退役：稿子里只剩候选行，一条候选一行，描述只长在候选上；
   台词另有自己的面板，改提示词不该连着改台词。 */
import assert from 'node:assert/strict';
import { scriptTextOf, parseScript, applyScript, scriptItemsOf } from '../web/director/script.js';

/* 一镜下面是一排候选镜头：每条自带一句描述与自己的状态。
   v1 是这一镜的主描述（origin auto），v2 / v3 各写各的。 */
const mk = () => ([
  { name: '河岸', shots: [
    { id: 's1', name: '开场', line: '你来了', lineWho: '林夏', draw: 2, candidates: [
      { vid: 'v1', status: 'draft', origin: 'auto', prompt: '河边，傍晚' },
      { vid: 'v2', status: 'succeeded', origin: 'manual', prompt: '候选自己的描述\n第二行' },
      { vid: 'v3', status: 'failed', origin: 'manual', prompt: '' },
    ] },
    { id: 's2', name: '', line: '', lineWho: '', draw: 1, candidates: [
      { vid: 'v4', status: 'draft', origin: 'auto', prompt: '远景' },
    ] },
  ] },
  { name: '', shots: [
    { id: 's3', name: '回头', line: '嗯', lineWho: '周岚', draw: 1, candidates: [
      { vid: 'v5', status: 'succeeded', origin: 'manual', prompt: '她回头\n一直在看你' },
    ] },
  ] },
]);

/* ---------- 写出：全片连续镜头号 + 只有候选行 + 续行缩进 ---------- */
const text = scriptTextOf(mk());
assert.equal(text, [
  '# 场景 1 · 河岸',
  '## 镜头 1 · 开场',
  '候选 1（草稿）：河边，傍晚',
  '候选 2（已完成）：候选自己的描述',
  '  第二行',
  '候选 3（生成失败）：',
  '',
  '## 镜头 2',
  '候选 1（草稿）：远景',
  '',
  '# 场景 2',
  '## 镜头 3 · 回头',
  '候选 1（已完成）：她回头',
  '  一直在看你',
  '',
].join('\n'), '镜头号跨场景连续；每条候选各占一行；多行描述续行缩进两个空格');
assert.doesNotMatch(text, /画面/, '稿子里不再有「画面」那一行：它已经退役');
assert.doesNotMatch(text, /沿用画面/, '「沿用画面」那种话已经不存在了');
assert.doesNotMatch(text, /台词|说话人/, '稿子里不出现台词与说话人（那两份数据各有各的面板）');
assert.equal(scriptTextOf([]), '', '没有场景时是空稿');

/* ---------- 解析：只认新格式 ---------- */
const parsed = parseScript(text);
assert.equal(parsed.blocks.length, 3);
assert.deepEqual(parsed.blocks.map(b => b.n), [1, 2, 3]);
assert.deepEqual(parsed.blocks[0].cands, [
  { n: 1, text: '河边，傍晚' },
  { n: 2, text: '候选自己的描述\n第二行' },
  { n: 3, text: '' },
], '候选行解析：文本恒为字符串，空串就是「这一条现在没有描述」');
assert.equal(parseScript('## 镜头 1\n候选 1（草稿）：半角冒号').blocks[0].cands[0].text, '半角冒号',
  '全角 / 半角冒号都认');
assert.equal(parseScript('随手一段没有镜头号的文字\n候选 1（草稿）：不算').blocks.length, 0,
  '没有 ## 镜头 N 的段落不参与写回');
assert.equal(parseScript('## 镜头 0\n候选 1（草稿）：x\n## 镜头 abc\n候选 1（草稿）：y').blocks.length, 0,
  '镜头号必须是正整数');

/* 旧格式不再解析：「画面：…」那一行现在没有任何落点，认了也是白认。 */
const old = parseScript('## 镜头 1\n画面：河边，傍晚\n候选 2（已完成）：候选自己的描述');
assert.deepEqual(old.blocks[0].cands, [{ n: 2, text: '候选自己的描述' }],
  '旧格式的「画面」行不解析');
assert.equal(old.blocks[0].fields, undefined, '段落里不再有「画面」那一项');

/* 没有冒号的候选行不认（当年「沿用画面」的写法没了）：不猜它属于哪一项。 */
assert.deepEqual(parseScript('## 镜头 1\n候选 1（草稿）').blocks[0].cands, [],
  '没有冒号的候选行不认');
assert.deepEqual(parseScript('## 镜头 1\n候选 1（草稿 · 沿用画面）').blocks[0].cands, [],
  '旧写法（状态里带「沿用画面」）不认');

/* ---------- 落点：每一项带回镜头 id + 候选 vid + 文本 ---------- */
{
  const scenes = mk();
  const { items, skipped } = scriptItemsOf(scenes, parsed, {});
  assert.equal(skipped, 0);
  assert.deepEqual(items.map(i => [i.shotId, i.vid, i.text]), [
    ['s1', 'v1', '河边，傍晚'],
    ['s1', 'v2', '候选自己的描述\n第二行'],
    ['s1', 'v3', ''],
    ['s2', 'v4', '远景'],
    ['s3', 'v5', '她回头\n一直在看你'],
  ], '每一项都带回镜头 id、候选 vid 与文本');
  assert.ok(items.every(i => i.ok), '稿子里出现的候选都还在');
}

/* ---------- 原样往返：一个字都不改 ---------- */
{
  const scenes = mk();
  const same = applyScript(scenes, parseScript(text));
  assert.equal(same.upd, 0, '原稿往返不该产生改动');
  assert.equal(same.blocks, 3);
  assert.equal(same.skipped, 0);
  assert.equal(same.takeSkipped, 0);
  assert.equal(scenes[0].shots[0].line, '你来了');
  assert.deepEqual(Object.keys(same).sort(),
    ['blocks', 'promptUpd', 'skipped', 'takeSkipped', 'takeUpd', 'total', 'upd'],
    '计数口径不变');
}

/* ---------- 改稿 → 候选：按 vid 写回那一条自己的描述 ---------- */
{
  const scenes = mk();
  const r = applyScript(scenes, parseScript([
    '## 镜头 1 · 开场',
    '候选 1（草稿）：河边，清晨',
    '候选 2（已完成）：改过的候选描述',
    '候选 3（生成失败）：',
  ].join('\n')));
  const cs = scenes[0].shots[0].candidates;
  assert.equal(cs[0].prompt, '河边，清晨', '主描述（这一镜默认那条候选）被改了');
  assert.equal(cs[1].prompt, '改过的候选描述', '第二条候选写的是它自己');
  assert.equal(cs[2].prompt, '', '空描述就是空，不回落给别人');
  assert.equal(r.upd, 2, '改了两条');
  assert.equal(r.promptUpd, 1, '主描述那一处单独计数');
  assert.equal(r.takeUpd, 1, '其余候选各自计数');
  assert.equal(r.takeSkipped, 0);
  assert.equal(scenes[0].shots[0].line, '你来了', '改描述不动台词');
  assert.equal(scenes[0].shots[0].lineWho, '林夏', '改描述不动说话人');
  assert.equal(scenes[0].shots[1].candidates[0].prompt, '远景', '没出现在稿子里的镜头一个字不动');
}

/* ---------- 写回按 vid 定位：第 N 行落到第 N 条候选身上，不是第 N 个下标 ---------- */
{
  const scenes = mk();
  /* 顺序表（打开剧本那一刻的快照）：第 2 行对应 v3，不是当前数组里的第 2 条。 */
  const order = new Map([['s1', ['v1', 'v3', 'v2']]]);
  const r = applyScript(scenes, parseScript('## 镜头 1\n候选 2（生成失败）：按 vid 落位\n'), { order });
  const cs = scenes[0].shots[0].candidates;
  assert.equal(cs[2].prompt, '按 vid 落位', '写到顺序表指的那一条（v3）');
  assert.equal(cs[1].prompt, '候选自己的描述\n第二行', '别的候选没被误写');
  assert.equal(r.takeUpd, 1);
}

/* ---------- 已删掉的候选：跳过并计数，不写到别人身上 ---------- */
{
  const scenes = mk();
  const order = new Map([['s1', ['v1', 'v2', 'v3']]]);
  const parsedOld = parseScript([
    '## 镜头 1',
    '候选 1（草稿）：河边，傍晚',
    '候选 2（已完成）：这一条已经被删了',
  ].join('\n'));
  /* 编辑期间第二条候选被删了：那一行要跳过并报数，不能落到剩下的那一条身上。 */
  scenes[0].shots[0].candidates.splice(1, 1);
  const r = applyScript(scenes, parsedOld, { order });
  const cs = scenes[0].shots[0].candidates;
  assert.equal(r.takeSkipped, 1, '被删掉的候选那一行要跳过并计数');
  assert.equal(r.takeUpd, 0);
  assert.equal(cs[0].prompt, '河边，傍晚', '还在的那一条没被误写');
  assert.equal(cs[1].prompt, '', '被删之前空着的那一条也没被误写');
}

/* ---------- 镜头号对不上：报数，不静默丢 ---------- */
{
  const scenes = mk();
  const r = applyScript(scenes, parseScript([
    '## 镜头 1',
    '候选 1（草稿）：还在',
    '## 镜头 9',
    '候选 1（草稿）：对不上的一镜',
  ].join('\n')));
  assert.equal(r.skipped, 1, '分镜里没有的镜头号要报数');
  assert.equal(r.upd, 1);
  assert.equal(r.promptUpd, 1, '写到的是这一镜的主描述（默认那条候选）');
  assert.equal(scenes[0].shots[0].candidates[0].prompt, '还在');
}

/* ---------- 重复的镜头号只认第一次 ---------- */
{
  const scenes = mk();
  const r = applyScript(scenes, parseScript('## 镜头 1\n候选 1（草稿）：第一次\n## 镜头 1\n候选 1（草稿）：第二次\n'));
  assert.equal(r.upd, 1);
  assert.equal(r.skipped, 1);
  assert.equal(scenes[0].shots[0].candidates[0].prompt, '第一次');
}

/* ---------- 旧稿写回：一处都不改（那一层已经退役） ---------- */
{
  const scenes = mk();
  const r = applyScript(scenes, parseScript('## 镜头 1\n画面：河边，清晨\n'));
  assert.equal(r.upd, 0, '旧格式的「画面」行不再落到任何地方');
  assert.equal(r.promptUpd, 0);
  assert.equal(r.takeUpd, 0);
  assert.equal(scenes[0].shots[0].candidates[0].prompt, '河边，傍晚');
  assert.equal(scenes[0].shots[0].prompt, undefined, '镜头级不再有描述那一项');
}

console.log('✓ director-script');
