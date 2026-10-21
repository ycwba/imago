#!/usr/bin/env node
/* watch 模式 —— 跑法：`npm run test:watch`（或 `node tests/watch.cjs`）
   fs.watch 监听 web/ 与 server/，任何改动防抖 800ms 后触发 `map.cjs --changed --run`
   （按改动挑常驻判据、用现选的 node 起子进程；浏览器判据不在这一档，那是 --run --e2e 的事）。
   两条硬要求：
     · 800ms 防抖 —— 一次保存常常是 rename+change 两枚事件，编辑器还会连击；
     · 在途合并 —— 一轮判据没跑完期间再改，不重复起第二个进程，只记「跑完还要再来一轮」，
       改一行期间永远最多一个 map 进程在跑。
   验收：改一个文件到出结果 8s 以内（防抖 0.8s + 起进程与挑中的几条判据）。
   Ctrl+C 退出；退出时把在途的 map 子进程带走，不留孤儿。 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const M = require('./map.cjs');

const root = path.resolve(__dirname, '..');
const DEBOUNCE_MS = Number(process.env.WATCH_DEBOUNCE_MS || 800);
const WATCH_DIRS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TARGETS = (WATCH_DIRS.length ? WATCH_DIRS : ['web', 'server'])
  .map(d => ({ abs: path.join(root, d), rel: d }));

const BIN = M.resolveNode();
console.log('watch：监听 ' + TARGETS.map(t => t.rel + '/').join(' ') + '，防抖 ' + DEBOUNCE_MS + 'ms，在途合并开');
console.log('  触发命令：node tests/map.cjs --changed --run（判据子进程 node：' + BIN + '）');
console.log('  Ctrl+C 退出。\n');

let timer = null;
let running = null;
let queued = false;
const seen = new Set();

function fire(reasonFiles) {
  if (running) {                 // 在途合并：这一轮还在跑，只记“跑完再补一轮”，不再起第二个
    queued = true;
    return;
  }
  const t0 = Date.now();
  console.log('\n[' + new Date().toLocaleTimeString() + '] 改动 ' + reasonFiles.size
    + ' 个文件（' + [...reasonFiles].slice(0, 6).join(', ')
    + (reasonFiles.size > 6 ? ' …' : '') + '）→ 跑 map.cjs --changed --run');
  running = cp.spawn(BIN, ['tests/map.cjs', '--changed', '--run'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  const done = () => {
    running = null;
    console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] 本轮结束'
      + (queued ? '（期间又有改动，立即补跑一轮）' : '，等待下一次改动。'));
    if (queued) { queued = false; schedule(0, new Set(seen)); }
    seen.clear();
  };
  running.on('exit', done);
  running.on('error', e => { console.log('✗ map 进程起不来：' + e.message); done(); });
}

function schedule(delay, batch) {
  clearTimeout(timer);
  timer = setTimeout(() => fire(batch || seen), delay);
}

for (const t of TARGETS) {
  if (!fs.existsSync(t.abs)) { console.error('✗ 目录不存在：' + t.rel); process.exit(1); }
  try {
    fs.watch(t.abs, { persistent: true, recursive: true }, (type, filename) => {
      if (!filename) return;
      const rel = t.rel + '/' + String(filename).split(path.sep).join('/');
      if (/\.(js|mjs|cjs|html|css)$/.test(rel)) seen.add(rel);
      schedule(DEBOUNCE_MS);
    });
  } catch (e) {
    console.error('✗ fs.watch ' + t.rel + '/ 失败（recursive 需要 Node 20+ / Windows 支持）：' + e.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\nwatch 退出。');
  if (running) { try { running.kill('SIGKILL'); } catch (e) {} }
  process.exit(0);
});
