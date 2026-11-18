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
const b = SA.bind([{ candidates: [{ vid: 'a', status: 'draft', origin: 'auto', prompt: '@小雅 走进河岸' }] }], entries);
assert.equal(b.n, 1);
assert.equal(b.shots, 1);
assert.deepEqual(pickOk, ['小雅']);
/* 认名走最长前缀匹配：标点尾巴 / 注记 / 正文连写都不再吞掉引用 ——
   这是「AI 写了 @ 却挂不上图」的根因（以前整段 token 当名字查库）。 */
pickOk.length = 0;
const bindOf = prompt => SA.bind([{ candidates: [{ vid: 'a', status: 'draft', origin: 'auto', prompt }] }], entries);
assert.equal(bindOf('@小雅，撑伞走过河岸').n, 1, '逗号尾巴不是名字的一部分');
assert.deepEqual(pickOk, ['小雅']);
pickOk.length = 0;
assert.equal(bindOf('@小雅（角色）出场').n, 1, '括号注记也不是名字的一部分');
assert.deepEqual(pickOk, ['小雅']);
pickOk.length = 0;
assert.equal(bindOf('@小雅撑着伞走过河岸').n, 1, '名字后直接连正文也能认出引用');
assert.deepEqual(pickOk, ['小雅']);
pickOk.length = 0;
/* 最长优先：「小雅丽」必须归小雅丽，不能被「小雅」抢走。 */
const entries2 = entries.concat([{ name: '小雅丽', desc: '另一位', pic: 'y' }]);
assert.equal(SA.bind([{ candidates: [{ vid: 'a', status: 'draft', origin: 'auto', prompt: '@小雅丽 在门口' }] }], entries2).n, 1);
assert.deepEqual(pickOk, ['小雅丽']);
/* 二级资产名只认中点写法：`@小雅·三视图` 那一路走 libPicChoices 的 note 匹配；
   正文尾巴（『，撑伞』）不进那一路。 */
pickOk.length = 0;
assert.equal(bindOf('@小雅，撑伞').n, 1);
assert.deepEqual(pickOk, ['小雅']);
/* 占位符跳过并计数；选中清单之外的名字回退全库认领。 */
const pend = bindOf('@待建:小雅 还没出图');
assert.equal(pend.n, 0);
assert.equal(pend.pending, 1, '占位符数出来报给调用方');
pickOk.length = 0;
assert.equal(SA.bind([{ candidates: [{ vid: 'a', status: 'draft', origin: 'auto', prompt: '@河岸 黄昏' }] }], []).n, 1,
  '没给选中清单时回退全库（AI 引用了没挑中的条目也能挂）');
assert.deepEqual(pickOk, ['河岸']);
/* shotsReferencing：@名字（含标点尾巴）算引用；占位符不算。 */
const shots = [
  { candidates: [{ vid: 'a', status: 'draft', origin: 'auto', prompt: '@小雅，撑伞走过' }] },
  { candidates: [{ vid: 'b', status: 'draft', origin: 'auto', prompt: '@待建:小雅 还没图' }] },
  { candidates: [{ vid: 'c', status: 'draft', origin: 'auto', prompt: '没提名字' }] },
];
assert.deepEqual(SA.shotsReferencing(shots, '小雅').map(x => x.candidates[0].vid), ['a'],
  '占位符不算引用（它归 shotsPending 管）');
const picked = await SA.pick({}, '小雅在河岸', entries);
assert.equal(picked.picked.length, 1);
assert.equal(picked.unknown, 0);
console.log('✓ 导演台 SplitAssets：范围 / 选项 / 目录 / 挂图（最长前缀认名）/ AI 挑选 / 引用查找');
