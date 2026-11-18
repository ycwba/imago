#!/usr/bin/env node
/* 拆分镜的文案闸门（web/director/split-form.js）：只挡空。
   统一格式之后只剩一个输入格 —— 新剧情 / 续写 / 修改要求都从这一格走，
   短要求（例：再加一个特写）也是有效要求，不再有 20 字下限与「任务档位」参数。 */
import assert from 'node:assert/strict';
import { splitScriptGate } from '../web/director/split-form.js';

assert.equal(splitScriptGate(''), '要拆的文案不能为空', '空文案挡住');
assert.equal(splitScriptGate(' '), '要拆的文案不能为空', '只打空格也是空');
assert.equal(splitScriptGate('一'), '', '一个字也放行：不再有 20 字下限');
assert.equal(splitScriptGate('一整段剧本贴在这里'), '');
assert.equal(splitScriptGate('加一个特写'), '', '短要求也是有效要求');
assert.equal(splitScriptGate(null), '要拆的文案不能为空', '没有输入同样挡住');

console.log('✓ director-split-form');
