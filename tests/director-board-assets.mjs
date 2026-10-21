#!/usr/bin/env node
/* 拆分镜的「新素材」：重复出现才建 / 名字对不上不建 / 占位符词法 / 建档落点。 */
import assert from 'node:assert/strict';
import { createBoardAssets } from '../web/director/board-assets.js';

const nameKey = s => String(s == null ? '' : s).trim().toLowerCase();
const BA = createBoardAssets({ nameKey, MIN_REPEAT: 2, PREFIX: '待建' });

const shots = [
  { prompt: '@待建:小雅 撑伞走过河岸', line: '你来了。', lineWho: '小雅' },
  { prompt: '小雅回头看了一眼', line: '', lineWho: '' },
  { prompt: '灯亮起来', line: '', lineWho: '' },
];

/* ① 重复出现才建：只出现一次的不建，并照实说为什么。 */
{
  const r = BA.plan([
    { name: '小雅', kind: 'actor', why: '反复出现', look: '短发少女' },
    { name: '河岸', kind: 'scene', why: '只出现一次' },
  ], shots, []);
  assert.equal(r.plan.length, 1, '只有重复出现的才建');
  assert.equal(r.plan[0].name, '小雅');
  assert.equal(r.plan[0].count, 2, '小雅出现两次');
  const sk = r.skipped.find(x => x.name === '河岸');
  assert.ok(sk, '没建的那几条要报出来');
  assert.match(sk.why, /只出现 1 次/, sk.why);
}

/* ② 素材库里已经有同名的 → 不建（那是复用，不是新建）。 */
{
  const r = BA.plan([{ name: '小雅', kind: 'actor' }], shots, [{ name: '小雅', kind: 'actor' }]);
  assert.equal(r.plan.length, 0);
  assert.match(r.skipped[0].why, /已经有同名/, r.skipped[0].why);
}

/* ③ 名字对不上（AI 编的）→ 不建，计数报出来。 */
{
  const r = BA.plan([{ name: '小雅' }, { name: '查无此人' }], shots, []);
  assert.equal(r.plan.length, 1, '编的名字不建');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].name, '查无此人');
}

/* ④ 短名不误命中：中文没有词边界，所以按**最长优先**统计 ——
      「小雅丽」先吃掉那处，「小雅」就只在自己真正出现的地方被数到。 */
{
  const n = BA.repeatCounts([{ prompt: '小雅丽在门口' }], ['小雅', '小雅丽']);
  assert.equal(n.get('小雅丽'), 1, '「小雅丽」自己算一次');
  assert.equal(n.get('小雅'), 0, '「小雅」不该从「小雅丽」那处数到：' + n.get('小雅'));
  const n2 = BA.repeatCount([{ prompt: '小雅在门口' }], '小雅');
  assert.equal(n2, 1, '「小雅在门口」里的「小雅」要算到：' + n2);
}

/* ⑤ 占位符词法：认得 `@待建:小雅`，也能把它换成真名。 */
{
  assert.ok(BA.isToken('@待建:小雅 撑伞走过河岸'));
  assert.deepEqual(BA.parse('@待建:小雅 撑伞走过河岸'), ['小雅']);
  assert.deepEqual(BA.pendingIn('@待建:小雅 走过'), ['小雅']);
  assert.deepEqual(BA.pendingIn('@待建:小雅 遇见 @待建:小雅'), ['小雅'], '同一个待建素材只算一次');
  const out = BA.resolve('@待建:小雅 撑伞走过河岸', '小雅', '小雅');
  assert.equal(out, '@小雅 撑伞走过河岸', '占位符换成真名：' + out);
  /* 只换占位符本身，正文一个字不动。 */
  const out2 = BA.resolve('小雅说：@待建:小雅 你来晚了', '小雅', '小雅');
  assert.equal(out2, '小雅说：@小雅 你来晚了');
  /* 普通 @引用 不是占位符。 */
  assert.ok(!BA.isToken('@小雅 走过'));
}

/* ⑥ 建档落点：组名 = 项目组名；类型决定写哪些字段。 */
{
  const item = { name: '小雅', kind: 'actor', look: '短发少女，灰色卫衣', voice: '年轻女声，清亮偏慢', why: '主角' };
  const spec = BA.libSpec(item, '校园篇');
  assert.equal(spec.name, '小雅');
  assert.equal(spec.group, '校园篇', '素材组名 = 项目组名');
  assert.equal(spec.kind, 'actor');
  assert.equal(spec.look, '短发少女，灰色卫衣');
  assert.equal(spec.voiceNote, '年轻女声，清亮偏慢', '音色描述落在 voiceNote（全站唯一）');
  assert.equal(spec.voiceMode, 'design');
  /* 未分组 → 组名空串（落未分组，界面上要说明）。 */
  const spec2 = BA.libSpec(item, '');
  assert.equal(spec2.group, '');
  /* 场景与物品的字段不一样。 */
  const sc = BA.libSpec({ name: '河岸', kind: 'scene', look: '黄昏的河岸' }, '校园篇');
  assert.equal(sc.kind, 'scene');
  assert.equal(sc.desc, '黄昏的河岸');
  assert.equal(sc.voiceNote, undefined, '场景没有音色');
  const pr = BA.libSpec({ name: '伞', kind: 'prop', look: '旧黑伞' }, '校园篇');
  assert.equal(pr.kind, 'prop');
  assert.equal(pr.look, '旧黑伞');
}

/* ⑦ 类型认不出来的当角色（角色那一类最常见，且道具没有音色）。 */
{
  assert.equal(BA.castKind('actor'), 'actor');
  assert.equal(BA.castKind('场景'), 'scene');
  assert.equal(BA.castKind('道具'), 'prop');
  assert.equal(BA.castKind('说不清'), 'actor');
  assert.equal(BA.castKind(undefined), 'actor');
}

console.log('✓ 导演台新素材：重复出现才建 / 名字对不上不建 / 占位符 / 建档落点');
