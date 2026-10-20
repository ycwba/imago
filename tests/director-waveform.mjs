#!/usr/bin/env node
/* 波形：空输入不出标记；包络画成上下对称的闭合多边形；空地址直接给 null（不解码、不发请求）。 */
import assert from 'node:assert/strict';
import { createWaveform } from '../web/director/waveform.js';

globalThis.window = {};
const W = createWaveform({ mediaSrc: s => '/getv?url=' + s, voiceOf: () => null });

assert.equal(W.waveformSVG([]), '');
assert.equal(W.waveformSVG([1]), '');
const svg = W.waveformSVG([0, 1, 0.5]);
assert.match(svg, /viewBox="0 0 100 20"/);
assert.match(svg, /preserveAspectRatio="none"/);
const pts = /points="([^"]+)"/.exec(svg)[1].trim().split(/\s+/);
assert.equal(pts.length, 6, '三点 × 上下两半');
assert.equal(pts[0], '0.00,10.00');
assert.ok(pts.includes('50.00,0.80'));
assert.ok(pts.includes('100.00,14.60'));

assert.equal(await W.voicePeaks(''), null);

console.log('✓ 声音轨波形：空输入 / 上下对称多边形 / 空地址不解码');
