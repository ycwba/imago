#!/usr/bin/env node
/* SplitAssets：范围解析 / 选项计数 / 目录与全文 / @名字 挂图。 */
import assert from 'node:assert/strict';
import { createSplitAssets } from '../web/director/split-assets.js';

const entries = [
  { name: '小雅', desc: '年轻女生，短发', pic: 'x' },
  { name: '河岸', desc: '黄昏的河岸' },
];
globalThis.window = {
  Chars: {
    Lib: {
      list: () => entries,
      groups: () => [{ name: '剧组' }],
      groupMatch: (x, g) => g === '剧组' && x.name === '小雅',
    },
    LIB_KINDS: { actor: '角色', scene: '场景' },
    libKindOf: x => (x.name === '河岸' ? 'scene' : 'actor'),
    descOf: x => x.desc || '',
    picOf: x => x.pic || '',
  },
};
const nameKey = s => String(s || '').trim().toLowerCase();
const byName = list => new Map((list || []).map(x => [nameKey(x.name), x]));
const pickOk = [];
const SA = createSplitAssets({
  BOARD_CTX_SHORT: 30, BOARD_CTX_PROMPT: 300, PICK_SOFT_MAX: 12,
  RULE_WITHOUT: '没有素材', RULE_WITH: '可用素材：', AT_TAIL: /[，。]+$/,
  libIdx: byName,
  libPicChoices: () => [],
  addLibPicToShot: (sh, x) => { pickOk.push(x.name); return { ok: true }; },
  nameKey,
  TextAI: { chat: async () => '{"assets":["小雅"]}' },
});

assert.equal(SA.resolve('none').kind, 'none');
assert.equal(SA.resolve('all').entries.length, 2);
assert.equal(SA.resolve('g:剧组').entries.length, 1);
assert.equal(SA.resolve('g:不存在').entries.length, 0);
const scopes = SA.scopes();
assert.ok(scopes.some(x => x.v === 'all' && /2 条/.test(x.t)));
assert.ok(scopes.some(x => x.v === 'g:剧组' && /1 条/.test(x.t)));
assert.match(SA.scopeText('g:剧组'), /分组「剧组」 1 条/);
const cat = SA.catalog(entries);
assert.match(cat, /小雅 · 角色/);
assert.match(cat, /河岸 · 场景/);
assert.match(cat, /还没有预览图/, '河岸没有预览图要标出来');
assert.match(SA.fullText([entries[0]]), /@小雅（角色）：年轻女生/);
const b = SA.bind([{ prompt: '@小雅 走进河岸' }], entries);
assert.equal(b.n, 1);
assert.equal(b.shots, 1);
assert.deepEqual(pickOk, ['小雅']);
const picked = await SA.pick({}, '小雅在河岸', entries);
assert.equal(picked.picked.length, 1);
assert.equal(picked.unknown, 0);
console.log('✓ 导演台 SplitAssets：范围 / 选项 / 目录 / 挂图 / AI 挑选');
