#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseJsonLoose, round1, round2, ctxClip } from '../web/director/util.js';

assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
assert.deepEqual(parseJsonLoose('说明在前 {"a":[1,2]} 说明在后'), { a: [1, 2] });
assert.deepEqual(parseJsonLoose('[{"t":0}]'), [{ t: 0 }]);
assert.equal(parseJsonLoose('不是 JSON'), null);
assert.equal(parseJsonLoose(''), null);
assert.equal(round1(1.24), 1.2);
assert.equal(round1('x'), 0);
assert.equal(round2(1.236), 1.24);
assert.equal(round2(null), 0);
assert.equal(ctxClip('abcdef', 3), 'abc…');
assert.equal(ctxClip('abc', 3), 'abc');
assert.equal(ctxClip(null, 3), '');
console.log('✓ 导演台 util：宽松 JSON / 一位与两位取整 / 截断');
