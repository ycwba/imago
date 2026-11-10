#!/usr/bin/env node
/* 轨道坞的两处纯逻辑：关键帧改时间（拖动与手填同一份）与逐帧颜色归一。
   不开浏览器 —— 只取 dock.js 的 retimeKey 与 schema.js 的 cleanColor。 */
import assert from 'node:assert/strict';
import { retimeKey } from '../web/pages/model/dock.js';
import { cleanColor } from '../web/model3d/schema.js';

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };
const eq = (a, b, m) => { n += 1; assert.deepEqual(a, b, m); };

/* ---------- ① 挪一帧：排序、身份保持、没动的帧原样 ---------- */
{
  const a = { t: 1, at: [0, 0, 0] };
  const b = { t: 2, at: [1, 0, 0] };
  const c = { t: 3, at: [2, 0, 0] };
  const out = retimeKey([a, b, c], c, 0.5);
  eq(out.map(k => k.t), [0.5, 1, 2], '挪到最前后按时间升序排好');
  ok(out[0] === c, '挪动的那一帧还是原来那个对象（选中状态不断线）');
  ok(out[1] === a && out[2] === b, '没动的那两帧身份不变');
  ok(out[0].at === c.at, '帧上的字段跟着对象一起走（不是重建一份）');
}

/* ---------- ② 时间：两位小数、非负、填不成数字按 0 ---------- */
{
  const k = { t: 1 };
  eq(retimeKey([k], k, 2.346).map(x => x.t), [2.35], '两位小数（2.346 → 2.35）');
  eq(retimeKey([k], k, -3).map(x => x.t), [0], '负数夹到 0');
  eq(retimeKey([k], k, '1.5').map(x => x.t), [1.5], '字符串数字也认');
  eq(retimeKey([k], k, 'x').map(x => x.t), [0], '填不成数字按 0');
  eq(retimeKey([k], k, 0.004).map(x => x.t), [0], '小于半厘的碎值落到 0');
}

/* ---------- ③ 同一时刻只留一帧：留下正在挪的那一份 ---------- */
{
  const a = { t: 1, at: [0, 0, 0] };
  const b = { t: 2, at: [1, 0, 0] };
  const out = retimeKey([a, b], b, 1);
  eq(out.map(k => k.t), [1], '两帧撞在同一时刻只留一帧');
  ok(out[0] === b, '被拖的那一份留下（它顶掉别人，不是被别人顶掉）');

  const a2 = { t: 1, at: [0, 0, 0] };
  const b2 = { t: 2, at: [1, 0, 0] };
  const out2 = retimeKey([a2, b2], a2, 2);
  eq(out2.map(k => k.t), [2], '往回拖撞上另一帧同样只留一帧');
  ok(out2[0] === a2, '往回拖时留下的仍是正在挪的那一份');

  const a3 = { t: 0.5 };
  const b3 = { t: 1 };
  eq(retimeKey([a3, b3], a3, 1.0004).length, 1, '1.00 与 1.00 是同一时刻（两位小数后相等）');
}

/* ---------- ④ 颜色：只认 #rgb / #rrggbb，其余当没写 ---------- */
{
  eq(cleanColor('#A1B2C3'), '#a1b2c3', '六位转小写');
  eq(cleanColor(' #abc '), '#aabbcc', '三位展开成六位并去空白');
  eq(cleanColor('#FFF'), '#ffffff', '三位白色展开');
  eq(cleanColor('#GGG'), '', '不是十六进制就当没写');
  eq(cleanColor('red'), '', '颜色名不收');
  eq(cleanColor(''), '', '空字符串当没写');
  eq(cleanColor(null), '', 'null 当没写');
}

console.log('✓ model3d-dock：' + n + ' 项通过');
