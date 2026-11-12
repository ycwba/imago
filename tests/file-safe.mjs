#!/usr/bin/env node
/* fileSafe 双份（Node / 浏览器各一份，登记在案的例外）的边界判据。
   两份的宿主环境不同（server 落盘真文件、ui 起下载名），默认值与首尾口径本就各自定；
   这里钉的是**共同必须成立的那一条**：Windows 保留设备名（CON / NUL / COM1…带任意
   扩展名都建不出文件）命中后必须解除，以及各自的文档化行为不漂。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const nodeSafe = require_('../server/file-safe.js').fileSafe;

/* 浏览器那份从 web/ui/ui.js 的闭包里抽出来在沙箱里跑（ui.js 是经典脚本，无法直接 import）。 */
const src = fs.readFileSync(path.join(root, 'web', 'ui', 'ui.js'), 'utf8');
const at = src.indexOf('function fileSafe(');
assert.ok(at > 0, 'web/ui/ui.js 里找得到 fileSafe');
const end = src.indexOf('\n  }', at);
const sandbox = { window: {} };
vm.runInNewContext(src.slice(at, end + 4) + '\nwindow.__fileSafe = fileSafe;', sandbox);
const uiSafe = sandbox.window.__fileSafe;

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
const NAMES = ['CON', 'CON.png', 'con.txt', 'NUL', 'NUL.jpg', 'PRN', 'AUX', 'COM1', 'com4.mp4', 'LPT2'];

let n = 0;
for (const name of NAMES) {
  const a = nodeSafe(name), b = uiSafe(name);
  n += 1;
  assert.ok(!RESERVED.test(a), 'server 保留名已解除：' + name + ' → ' + a);
  assert.ok(!RESERVED.test(b), 'ui 保留名已解除：' + name + ' → ' + b);
  assert.ok(!RESERVED.test(a + '.png') || a.endsWith('_'), 'server 加扩展名后仍安全：' + a);
}
console.log('✓ 保留设备名 ' + NAMES.length + ' 个 × 两份同解除');

/* server 侧的文档化行为：非法字符换 -、首尾点与 - 去掉、max 截断、全空回空串 */
assert.equal(nodeSafe('a/b\\c:d*e?f"g<h>i|j\u0007k'), 'a-b-c-d-e-f-g-h-i-j-k'), n += 1;
assert.equal(nodeSafe('.hidden.'), 'hidden'), n += 1;
assert.ok(nodeSafe('x'.repeat(200), 24).length <= 24, 'max 截断'), n += 1;
assert.equal(nodeSafe('   '), '', '全空输入回空串（调用方自己兜名）'), n += 1;
assert.equal(nodeSafe('我的镜头 01.mp4'), '我的镜头 01.mp4', '正常名字原样'), n += 1;

/* ui 侧的文档化行为：全空回「素材」、默认 24 字 */
assert.equal(uiSafe('   '), '素材', '全空输入回「素材」'), n += 1;
assert.ok(uiSafe('x'.repeat(200)).length <= 24, '默认 24 字截断'), n += 1;

console.log('✓ file-safe：' + n + ' 项通过（Node + 浏览器两份，保留名共同解除 / 各自文档化行为不漂）');
process.exit(0);
