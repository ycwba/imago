#!/usr/bin/env node
/* 拆分镜那一档的文案闸门（web/director/split-form.js）：接着往下拆只挡空。
   以前它和「拆一份新的」共用一条 20 字下限，「再加一个特写」这种短要求根本发不出去。
   「拆一份新的」那一档已删（拆分镜只留「修改现有分镜 / 接着往下拆」，都落在当前短片上）。 */
import assert from 'node:assert/strict';
import { splitScriptGate } from '../web/director/split-form.js';

assert.equal(splitScriptGate('append', ''), '要接着拆的文案不能为空', '接着往下拆：空文案挡住');
assert.equal(splitScriptGate('append', ' '), '要接着拆的文案不能为空', '只打空格也是空');
assert.equal(splitScriptGate('append', '一'), '', '一个字也放行：不再有 20 字下限');
assert.equal(splitScriptGate('append', '一整段剧本贴在这里'), '');
assert.equal(splitScriptGate('append', '加一个特写'), '', '短要求也是有效要求');

assert.equal(splitScriptGate('edit', ''), '', '改现有分镜那一档用「修改要求」那一格，不走这道闸');
assert.equal(splitScriptGate('edit', '随便'), '');

console.log('✓ director-split-form');
