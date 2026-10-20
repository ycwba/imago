#!/usr/bin/env node
/* 片段模型：老数据归一 / 框包住选区 / 调过的音量·倍速·行号不丢 / 落回端口径。 */
import assert from 'node:assert/strict';
import {
  segLen, segSpd, segVol, segFilmLen, segsOf, segsFilmLen, segsCopy, segsWrite,
  laneClamp, picLnOf, tlClipDur, TRACK_LANES_MAX, SEG_MIN,
} from '../web/director/segments.js';

assert.equal(SEG_MIN, 0.2);
assert.equal(TRACK_LANES_MAX, 12);
assert.equal(laneClamp(99), 11);
assert.equal(picLnOf({ ln: 2 }), 2);
assert.equal(segLen({ in: 1, out: 4 }), 3);
assert.equal(segSpd({ spd: 9 }), 4);
assert.equal(segVol({ vol: 9 }), 2);
assert.equal(segFilmLen({ in: 0, out: 4, spd: 2 }), 2);
assert.equal(tlClipDur({ in: 1, out: 5, speed: 2 }), 2);

/* 老数据只有 trimS/trimE：框 = 选区 */
let list = segsOf({ trimS: 1, trimE: 3 }, 10);
assert.equal(list.length, 1);
assert.deepEqual(list[0], { in: 1, out: 3, a: 1, b: 3 });

/* 框必须包住选区；调过的四件跟着走（缺省不占键） */
list = segsOf({ segs: [{ in: 1, out: 3, a: 0.5, b: 4, vol: 0.5, spd: 2, ln: 1, off: 1 }] }, 10);
assert.deepEqual(list[0], { in: 1, out: 3, a: 0.5, b: 4, vol: 0.5, spd: 2, ln: 1, off: 1 });
list = segsOf({ segs: [{ in: 1, out: 3, a: 2.5, b: 1 }] }, 10);
assert.equal(list[0].a, 1, '框左沿被夹到选区起点');
assert.equal(list[0].b, 3, '框右沿被夹到选区终点');
assert.equal('vol' in list[0], false);
assert.equal('spd' in list[0], false);

/* 零长段被撑到最小时长；空列表才是有效状态 */
const tiny = segsOf({ segs: [{ in: 2, out: 2 }] }, 10);
assert.equal(tiny.length, 1);
assert.ok(Math.abs((tiny[0].out - tiny[0].in) - 0.2) < 1e-9);
assert.equal(segsOf({ segs: [] }, 10).length, 0);
assert.deepEqual(segsOf({}, 0), [{ in: 0, out: 0.1, a: 0, b: 0.1 }]);

/* 复制带走全部四件；segsWrite 回写 trimS/trimE，并把第一行的 ln=0 摘掉 */
const copy = segsCopy([{ in: 1, out: 3, a: 1, b: 3, vol: 0.5, spd: 2, ln: 1 }]);
assert.deepEqual(copy[0], { in: 1, out: 3, a: 1, b: 3, vol: 0.5, spd: 2, ln: 1 });
const cand = {};
const wrote = segsWrite(cand, 10, [{ in: 0, out: 2 }, { in: 3, out: 5 }]);
assert.equal(wrote.length, 2);
assert.equal(cand.trimS, 0);
assert.equal(cand.trimE, 5);
assert.equal(segsFilmLen({ segs: [{ in: 0, out: 4, spd: 2 }, { in: 4, out: 6 }] }, 10), 4);

console.log('✓ 片段模型：归一 / 框包住选区 / 四件搬运 / 落回口径');
