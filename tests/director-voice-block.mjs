#!/usr/bin/env node
/* 配音块标记：框/选区、锁与溢出不给把手、灰场带与成片秒读数。 */
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
let s = html(v, { l: 1, w: 2 }, { l: 1, w: 2 }, 10, '拖块体');
assert.match(s, /class="tl-v"/);
assert.match(s, /left:10%;width:20%/);
assert.match(s, /data-vcut="v1"/);
assert.match(s, /data-i="speaker"/);
assert.doesNotMatch(s, /vo-off/);
assert.doesNotMatch(s, /vo-skip/);

/* 框内被剪掉的头尾：两块灰；锁上：把手一颗不画，title 说出解锁方向 */
s = html(v, { l: 1, w: 3 }, { l: 1.5, w: 1 }, 10, '拖块体');
assert.match(s, /class="vo-off"/);
locked = true;
s = html(v, { l: 1, w: 3 }, { l: 1.5, w: 1 }, 10, '拖块体');
assert.doesNotMatch(s, /data-vcut/);
assert.match(s, /配音轨第 1 行锁着/);
assert.match(s, /点左边那只锁/);
locked = false;

/* 灰场：成片秒读数只算真洞，块顺延拉长 */
s = html(v, { l: 0, w: 3 }, { l: 1, w: 2 }, 10, '拖块体', { gray: [[2, 3, 1]] });
assert.match(s, /class="vo-skip"/);
assert.match(s, /顺延到/);
assert.match(s, /成片里念 3 秒/);

/* 溢出块：只读，不给把手，也不拉长 */
s = html(v, { l: 4, w: 1 }, { l: 4, w: 1 }, 10, '别的镜', { spill: true, gray: [[4.2, 4.5, 1]] });
assert.match(s, /class="tl-v spill/);
assert.doesNotMatch(s, /data-vcut/);
assert.match(s, /跳到你那一句自己那一镜/);

/* 选中态 */
selId = 'v1';
s = html(v, { l: 1, w: 3 }, { l: 1, w: 2 }, 10, '拖块体');
assert.match(s, / sel"/);
assert.equal(pct(5, 10), 50);
assert.equal(spdTxt(1.25), '×1.25');

console.log('✓ 配音块标记：框选区 / 锁 / 灰场 / 溢出 / 选中');
