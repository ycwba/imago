#!/usr/bin/env node
/* 配音块标记：块画的就是选区（不再有框内灰）、锁与溢出不给把手、黑场带与成片秒读数。 */
import assert from 'node:assert/strict';
import { createVoiceBlockRenderer, voiceBlockText, voiceBlockLabel } from '../web/director/voice-block.js';
import { pct, spdTxt } from '../web/director/util.js';

let locked = false;
let selId = '';
const html = createVoiceBlockRenderer({
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  icon: (n, s) => `<i data-i="${n}"></i>`,
  voiceSelId: () => selId,
  voiceLn: () => 0,
  rowLocked: () => locked,
  rowLockWhy: () => '配音轨第 1 行锁着',
  rowUnlockHow: () => '点左边那只锁',
});

assert.equal(voiceBlockLabel({ name: '很长的名字超过十个字了' }), '很长的名字超过十个字');
assert.equal(voiceBlockText({ spd: 1 }, 2.25), '配音 · 2.3s');
assert.equal(voiceBlockText({ spd: 2 }, 2.25), '配音 · 2.3s ×2');

const v = { id: 'v1', at: 1, dur: 2, spd: 1, vol: 1, src: 'a.mp3' };
let s = html(v, { l: 1, w: 2 }, 10, '拖块体');
assert.match(s, /class="tl-v"/);
assert.match(s, /left:10%;width:20%/);
assert.match(s, /data-vcut="v1"/);
assert.match(s, /data-i="speaker"/);
/* 框内剪掉的头尾不再画：块上没有任何「遮挡 / 灰」那一层，只留黑场跳过带 */
assert.doesNotMatch(s, /vo-off/);
assert.doesNotMatch(s, /vo-skip/);

/* 锁上：把手一颗不画，title 说出解锁方向 */
locked = true;
s = html(v, { l: 1, w: 3 }, 10, '拖块体');
assert.doesNotMatch(s, /data-vcut/);
assert.match(s, /配音轨第 1 行锁着/);
assert.match(s, /点左边那只锁/);
assert.match(s, /left:10%;width:30%/);
locked = false;

/* 黑场：块顺延拉长，小字报的是它在**成片里占几秒**（音频 3 秒 + 黑场停住的那 1 秒） */
s = html(v, { l: 0, w: 3 }, 10, '拖块体', { gray: [[2, 3, 1]] });
assert.match(s, /left:0%;width:40%/);
assert.match(s, /class="vo-skip"/);
assert.match(s, /顺延到 4 秒/);
assert.match(s, /成片里念 4 秒/);

/* 溢出块：只读，不给把手，也不拉长 */
s = html(v, { l: 4, w: 1 }, 10, '别的镜', { spill: true, gray: [[4.2, 4.5, 1]] });
assert.match(s, /class="tl-v spill/);
assert.doesNotMatch(s, /data-vcut/);
assert.match(s, /跳到你那一句自己那一镜/);
assert.doesNotMatch(s, /顺延到/, '溢出块只画带、不顺延：那一截锚在别的镜上');

/* 选中态 */
selId = 'v1';
s = html(v, { l: 1, w: 3 }, 10, '拖块体');
assert.match(s, / sel"/);
assert.equal(pct(5, 10), 50);
assert.equal(spdTxt(1.25), '×1.25');

console.log('✓ 配音块标记：选区即块宽 / 锁 / 黑场顺延 / 溢出 / 选中');
