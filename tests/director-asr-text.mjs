#!/usr/bin/env node
/* 浏览器内 ASR 的纯算法面（web/director/asr-text.js）：worker 与这里的判据读同一份。
   WAV 拆 PCM / 词级成段（断句、时长、字数三把尺）/ 中文转写清理与可疑判定。
   另有一条静态档：vendor 四件在场、worker 只走同源地址且 allowRemoteModels 关死 ——
   模型与 wasm 从 CDN 直取是 CSP 下必死的坏法，要在起进程之前拦住。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavToPcm, groupWords, normalizeAsrWhitespace,
  applyChineseReplacements, isSuspiciousChineseTranscript, CHINESE_ASR_CONTEXT_REPLACEMENTS } from '../web/director/asr-text.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* ---------- wavToPcm ---------- */

/* 手拼一份 16k / 单声道 / 16-bit 的最小 WAV：RIFF 头 + fmt + data。 */
function mkWav(samples, { rate = 16000, channels = 1, bits = 16, format = 1 } = {}) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * bits / 8, 28);
  buf.writeUInt16LE(channels * bits / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(samples[i] * 32768), 44 + i * 2);
  return buf;
}

assert.deepEqual(
  Array.from(wavToPcm(mkWav([0, 0.5, -1]).buffer)),
  [0, 0.5, -1],
  '16-bit PCM 原样换算成 [-1, 1] 的浮点');
assert.equal(wavToPcm(mkWav(new Array(16000).fill(0))).length, 16000, '一秒静音就是 16000 个点');
assert.throws(() => wavToPcm(Buffer.alloc(44)), /不是 WAV|fmt/, '没有 data 块要拒');
assert.throws(() => wavToPcm(mkWav([0], { rate: 44100 })), /16k/, '非 16k 采样率要拒');
assert.throws(() => wavToPcm(mkWav([0], { channels: 2 })), /单声道/, '立体声要拒');
assert.throws(() => wavToPcm(mkWav([0], { format: 3 })), /16-bit|PCM/, 'float 格式要拒');

/* ---------- groupWords ---------- */

const w = (text, start, end) => ({ text, timestamp: [start, end] });

assert.deepEqual(groupWords([]), [], '空词表回空段');
assert.deepEqual(groupWords(null), [], 'null 也不崩');
assert.deepEqual(groupWords([w('你好', 0, 0.5), w('世界', 0.6, 1.2)]),
  [{ start: 0, end: 1.2, text: '你好世界' }], '贴着的中文词并成一段');
assert.deepEqual(groupWords([w('你好', 0, 0.5), w('世界', 1.5, 2.2)]),
  [{ start: 0, end: 0.5, text: '你好' }, { start: 1.5, end: 2.2, text: '世界' }],
  '词间静音超过 0.6 秒断开');
assert.equal(groupWords([w('今天天气', 0, 0.3), w('真不错。', 0.4, 0.8), w('我们去公园', 0.9, 1.4)]).length, 2,
  '句末标点收段');
assert.equal(groupWords([w('今天天气', 0, 0.3), w('真不错', 0.4, 0.8), w('我们去公园', 0.9, 1.4)]).length, 1,
  '没有标点就一直并下去');
assert.deepEqual(groupWords([w('hello', 0, 0.3), w('world', 0.4, 0.8)]),
  [{ start: 0, end: 0.8, text: 'hello world' }], '拉丁词之间补空格');
assert.deepEqual(groupWords([w('你好', 0, 0.3), w('hello', 0.4, 0.8)]),
  [{ start: 0, end: 0.8, text: '你好hello' }], '中英交界不补空格（ASR 词面原样）');
assert.equal(groupWords([w('a'.repeat(30), 0, 0.3), w('b'.repeat(30), 0.4, 0.8)]).length, 2,
  '攒满 40 字收段');
/* 末尾残词并进上一条：字幕不丢最后一小句。 */
const tail = groupWords([w('你好', 0, 0.5), w('世界', 1.5, 2.0), w('啊', 2.5, 2.9)]);
assert.equal(tail[tail.length - 1].text, '世界啊', '末尾残词并进上一条');
assert.deepEqual(groupWords([w('', 0, 0.5), w('有字', 0.6, 1)]),
  [{ start: 0.6, end: 1, text: '有字' }], '空词过滤掉');
/* timestamp 缺失按 0 兜，不抛。 */
assert.deepEqual(groupWords([{ text: '裸词' }]), [{ start: 0, end: 0, text: '裸词' }], '没有时间戳的词也收');

/* ---------- 文本清理 ---------- */

assert.equal(normalizeAsrWhitespace('你 好，世 界'), '你好，世界', '中日文字符之间的空格全去');
assert.equal(normalizeAsrWhitespace('hello world'), 'hello world', '拉丁词之间的空格保留');
assert.equal(normalizeAsrWhitespace('  你好  '), '你好', '首尾空白裁掉');
assert.equal(normalizeAsrWhitespace('第一行\r\n第二行'), '第一行第二行', '中日文字符之间的换行同样算空白（段内本就单行）');
assert.equal(normalizeAsrWhitespace('有字\r'), '有字', '裸回车清掉');
assert.equal(normalizeAsrWhitespace('カタ カナ'), 'カタカナ', '日文假名之间同样去空格');

/* 误识表：空表 = 原样；临时塞一条条目要真的替换（试完清掉，不污染别的判据）。 */
assert.equal(applyChineseReplacements('原样输出'), '原样输出', '空表按原样回');
CHINESE_ASR_CONTEXT_REPLACEMENTS.push(['成像', '成样']);
assert.equal(applyChineseReplacements('成像工作台'), '成样工作台', '表目按整词替换');
CHINESE_ASR_CONTEXT_REPLACEMENTS.length = 0;
assert.equal(applyChineseReplacements('成像工作台'), '成像工作台', '清表之后回到原样');

/* ---------- 中文可疑判定 ---------- */

assert.equal(isSuspiciousChineseTranscript('这是一段正常的中文转写结果'), false, '正常中文不标疑');
assert.equal(isSuspiciousChineseTranscript('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true, '超长拉丁串多半是误识');
assert.equal(isSuspiciousChineseTranscript('hello world foo bar baz qux'), true, '拉丁占比过高标疑');
assert.equal(isSuspiciousChineseTranscript(' mixed with 汉字 enough here ok'), true, '混着中文但拉丁占多也标疑');
assert.equal(isSuspiciousChineseTranscript(''), false, '空文本不标疑');

/* ---------- 静态档：vendor 与 CSP 约束 ---------- */

const vendorDir = path.join(root, 'web', 'vendor', 'asr');
for (const f of ['transformers.min.js', 'ort.bundle.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm']) {
  const p = path.join(vendorDir, f);
  assert.ok(fs.existsSync(p) && fs.statSync(p).size > 0, 'vendor 在场且非空：' + f);
}

const workerSrc = fs.readFileSync(path.join(root, 'web', 'director', 'asr-worker.js'), 'utf8');
assert.match(workerSrc, /allowRemoteModels\s*=\s*false/, 'worker 关死远程模型（页面不直连外部域名）');
assert.match(workerSrc, /env\.localModelPath\s*=\s*'\/models\/'/, '模型只走代理同源的 /models/');
assert.match(workerSrc, /const WASM_DIR\s*=\s*'\/web\/vendor\/asr\/'/, 'ORT wasm 指到同源 vendor（默认 CDN 在 CSP 下必死）');
assert.match(workerSrc, /wasmPaths\s*=\s*WASM_DIR/, 'wasmPaths 吃的就是这份同源常量');
assert.match(workerSrc, /import\s*\{[^}]*\}\s*from\s*'\/web\/vendor\/asr\/transformers\.min\.js'/,
  'transformers.js 从同源 vendor 引');
assert.match(workerSrc, /import\s*\{[^}]*\}\s*from\s*'\/web\/director\/asr-text\.js'/,
  '分段与清理只从 asr-text.js 一份');
assert.doesNotMatch(workerSrc, /https?:\/\/(?!local)/, 'worker 源码里不出现外部 http(s) 地址');
/* 设置侧同一份判据：whisper q8 的路线可选、模型清单与 worker 的 MODEL_ID 一致。 */
const asrClient = fs.readFileSync(path.join(root, 'web', 'domain', 'asr.js'), 'utf8');
assert.match(asrClient, /whisper-small_timestamped/, '页面侧声明的模型 id 与 worker 一致');
assert.match(asrClient, /asr-worker\.js.*type:\s*'module'/, 'worker 以 module 起才吃得到 import.meta.url 的 publicPath');
const asrStore = fs.readFileSync(path.join(root, 'server', 'data-hub.js'), 'utf8');
assert.match(asrStore, /ROUTES\s*=\s*new Set\(\[.*'browser'/s, '服务端路线集合认 browser');

/* 静态路由要真放行 .wasm 并带对类型：白名单漏了 wasm 那阵子，ORT 拿到的是 9 字节
   404 文本 "not found"，报「expected magic word … found 6e 6f 74 20」。这两条是回归锁。 */
const staticRouteSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'static.js'), 'utf8');
assert.match(staticRouteSrc, /\(html\|js\|cjs\|css\|wasm\|/, '静态扩展名白名单要含 wasm');
const appMimeSrc = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
assert.match(appMimeSrc, /['"]\.wasm['"]\s*:\s*['"]application\/wasm['"]/, 'MIME 表要有 .wasm → application/wasm');
assert.match(staticRouteSrc, /writeHead\(404,\s*\{\s*'Cache-Control':\s*'no-store'\s*\}\)/,
  '静态 404 要 no-store（旧 404 不许被浏览器启发式缓存）');

console.log('✓ director-asr-text：' + [
  'wavToPcm', 'groupWords', 'normalizeAsrWhitespace', 'applyChineseReplacements',
  'isSuspiciousChineseTranscript', 'vendor/CSP 静态档',
].join(' / '));
