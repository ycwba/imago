#!/usr/bin/env node
/* 配音的分轨 / 合轨与新句落行（web/director/voice-lanes.js）：分组稳定、只动行号、超上限点名，不静默夹。
   这三条是「时间不要乱」的全部保证 —— 分轨只改画在第几行，别的字段一个字节都不许变；
   新句落行只认时间窗，不认「整行空不空」。 */
import assert from 'node:assert/strict';
import { defaultKeyOf, groupByMaterial, planLaneRows, applyLanePlan, pickVoiceLane } from '../web/director/voice-lanes.js';

/* 分组键三级兜底：谁在说 → 音色 → 素材身份；空串不占键。 */
assert.equal(defaultKeyOf({ who: '小美', voice: 'v1', src: '/asset/a' }), 'who:小美', '说话人优先');
assert.equal(defaultKeyOf({ who: '  ', voice: 'v1', src: '/asset/a' }), 'voice:v1', '空说话人落到音色');
assert.equal(defaultKeyOf({ who: '', voice: '', src: '/asset/a' }), 'src:/asset/a', '再落到素材');
assert.equal(defaultKeyOf({ who: '', voice: '', src: 'https://x/a.mp3?sig=1' }, u => u.split('?')[0]),
  'src:https://x/a.mp3', '素材身份交给调用方剥签名参数');
assert.equal(defaultKeyOf({}), 'src:', '三样都没有也给一个稳定的空键（不抛）');

/* 同一角色归一组；顺序按首次出现；输入对象一个字段都不改。 */
const voices = [
  { id: 'a', ln: 0, who: '小美', voice: 'qing', src: '/asset/1', at: 1.5, dur: 2, vol: 0.8, fa: 0, fb: 2, text: '第一句', seg: 0, shotId: 's1', candId: 'c1' },
  { id: 'b', ln: 0, who: '阿强', voice: 'shen', src: '/asset/2', at: 4, dur: 1, vol: 1, fa: 3, fb: 5, text: '第二句', seg: 1, shotId: 's1', candId: 'c1' },
  { id: 'c', ln: 2, who: '小美', voice: 'qing', src: '/asset/3', at: 7.25, dur: 3, vol: 1.2, fa: 6, fb: 9, text: '第三句', seg: 0, shotId: 's2', candId: 'c2' },
];
const snapshot = JSON.stringify(voices);
const groups = groupByMaterial(voices, v => defaultKeyOf(v));
assert.equal(JSON.stringify(voices), snapshot, '分组不改任何配音对象');
assert.deepEqual(groups.map(g => g.key), ['who:小美', 'who:阿强'], '分组顺序 = 首次出现顺序');
assert.deepEqual(groups[0].voices.map(v => v.id), ['a', 'c']);
assert.equal(groups[0].label, '小美');
assert.deepEqual(groupByMaterial(voices, v => defaultKeyOf(v)).map(g => [g.key, g.voices.length]),
  groups.map(g => [g.key, g.voices.length]), '同一份数据算两次结果相同');

/* 没有说话人也没有音色时，标签取组内第一个有名字的成员；都没有才用键。 */
const noName = groupByMaterial([{ id: 'x', src: '/asset/x' }, { id: 'y', src: '/asset/x', name: '旁白' }], () => 'same');
assert.equal(noName.length, 1);
assert.equal(noName[0].label, '旁白', '标签取组内第一个有名字的成员');
assert.equal(groupByMaterial([{ src: '/asset/x' }], () => 'src:/asset/x')[0].label, '/asset/x',
  '都没有名字就用去掉前缀的键');

/* 行号分配：前 maxRows 组落 0..maxRows-1；第 13 组起进 overflow，点名、不静默夹。 */
const many = Array.from({ length: 13 }, (_, i) => ({ key: 'who:' + i, label: '角色' + i, voices: [{ id: 'v' + i }] }));
const planned = planLaneRows(many, 12);
assert.equal(planned.rows.length, 12);
assert.deepEqual(planned.rows.map(r => r.ln), Array.from({ length: 12 }, (_, i) => i));
assert.equal(planned.overflow.length, 1, '超出上限的组单独报出来');
assert.equal(planned.overflow[0].key, 'who:12');
assert.equal(planned.overflow[0].label, '角色12');
assert.equal(planned.overflow[0].count, 1);
assert.deepEqual(planLaneRows(many.slice(0, 3), 12).overflow, [], '没超上限时 overflow 是空的');
assert.equal(planLaneRows(many, 0).rows.length, 1, '上限写坏也至少留一行');

/* 执行分配：只写 ln，别的时间 / 音量 / 选区 / 倍速字段逐项相同；只改真的变了的。 */
const before = voices.map(v => ({ ...v }));
const rows = planLaneRows(groups, 12).rows;
const moved = applyLanePlan(rows);
assert.equal(moved, 2, 'b 0 → 1、c 2 → 0，共两句；已经在目标行上的 a 不重写');
voices.forEach((v, i) => {
  const { ln: _after, ...restAfter } = v;
  const { ln: _before, ...restBefore } = before[i];
  assert.deepEqual(restAfter, restBefore, '除 ln 以外的字段一个字节都没变：' + v.id);
  assert.deepEqual(Object.keys(v).filter(k => k !== 'ln'), Object.keys(before[i]).filter(k => k !== 'ln'),
    '也没有多出别的键：' + v.id);
});
assert.equal(voices[0].ln, 0);
assert.equal(voices[1].ln, 1, '第 2 组的句落到第 2 行（ln = 1）');
assert.equal(voices[2].ln, 0, '同一角色的第二句并回第 1 行');
assert.equal(applyLanePlan(rows), 0, '同一份分配再算一次：没人需要动');

/* 合轨 = 所有句并进第 1 行（ln 0），时间字段照旧一个不动。 */
const mergeBefore = JSON.stringify(voices.map(({ ln, ...rest }) => rest));
const mergeRows = [{ key: 'all', label: '全部', ln: 0, voices }];
applyLanePlan(mergeRows);
assert.ok(voices.every(v => v.ln === 0), '合轨后所有 ln === 0');
assert.equal(JSON.stringify(voices.map(({ ln, ...rest }) => rest)), mergeBefore, '合轨也不动时间字段');

/* 空列表不炸。 */
assert.deepEqual(groupByMaterial([], v => defaultKeyOf(v)), []);
assert.deepEqual(planLaneRows([], 12), { rows: [], overflow: [] });
assert.equal(applyLanePlan([]), 0);
assert.equal(applyLanePlan(null), 0);

/* 新句落行（pickVoiceLane）：判「目标时间窗内有没有被占」，多行可用取行号最小的。 */
const lane0 = [
  { ln: 0, l: 0, w: 4 },
  { ln: 1, l: 0, w: 2 },
];
assert.deepEqual(pickVoiceLane(lane0, { l: 5, w: 1 }, 2, 12), { ln: 0, needNewRow: false, why: '' },
  '第 0 行在目标时间窗里空着 → 落第 0 行');
assert.deepEqual(pickVoiceLane(lane0, { l: 1, w: 1 }, 2, 2), { ln: -1, needNewRow: false, why: 'lanefull' },
  '两行都占着这一秒且已到上限 → lanefull');
assert.deepEqual(pickVoiceLane(lane0, { l: 1.5, w: 0.5 }, 2, 3), { ln: 2, needNewRow: true, why: '' },
  '两行都占着但还可以新开 → ln = 当前整条轨的行数');

/* 判据是时间窗，不是整行：同一行别处有句子，这一句照样能落进来。 */
assert.deepEqual(pickVoiceLane([{ ln: 0, l: 0, w: 1 }, { ln: 1, l: 6, w: 1 }], { l: 3, w: 1 }, 2, 12),
  { ln: 0, needNewRow: false, why: '' }, '目标窗与两行都不相交 → 取最小行号 0');
/* 传进来的是框：一句的选区已经不在目标上、但框还压着，照样算占（与轨道上看到的块一致）。 */
assert.deepEqual(pickVoiceLane([{ ln: 0, l: 0, w: 5 }, { ln: 1, l: 9, w: 1 }], { l: 4.5, w: 0.3 }, 2, 12),
  { ln: 1, needNewRow: false, why: '' }, '框压着目标 → 不选这一行');
/* 边界：新句左沿恰好贴着一句的右沿 = 不相交（首尾相接不算重叠）。 */
assert.deepEqual(pickVoiceLane([{ ln: 0, l: 0, w: 2 }, { ln: 1, l: 0, w: 1 }], { l: 2, w: 1 }, 2, 12),
  { ln: 0, needNewRow: false, why: '' }, '首尾相接不算占');
/* 行数 = 上限且全占 → lanefull；rows 传 0 / 负数也至少问一行。 */
const full12 = Array.from({ length: 12 }, (_, i) => ({ ln: i, l: 0, w: 2 }));
assert.deepEqual(pickVoiceLane(full12, { l: 1, w: 1 }, 12, 12), { ln: -1, needNewRow: false, why: 'lanefull' },
  '12 行全占 → lanefull（原因码，不在纯模块里拼中文）');
assert.deepEqual(pickVoiceLane([], { l: 1, w: 1 }, 0, 12), { ln: 0, needNewRow: false, why: '' },
  '行数写坏也至少问第 0 行');
assert.deepEqual(pickVoiceLane([{ ln: 0, l: 0, w: 2 }], { l: 1, w: 1 }, 1, 1), { ln: -1, needNewRow: false, why: 'lanefull' },
  '上限只有一行且被占 → lanefull');
assert.deepEqual(pickVoiceLane(null, { l: 0, w: 0.01 }, 2, 12), { ln: 0, needNewRow: false, why: '' },
  '没有已有句子 → 第 0 行');

console.log('✓ director-voice-lanes');
