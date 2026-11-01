#!/usr/bin/env node
/* 用户数据基线 —— 跑法：`node tests/data-snapshot.cjs`（只读比对）
   重打基线要两条一起：`DATA_SNAPSHOT_WRITE=1 node tests/data-snapshot.cjs --write`。
   只记录每个目录的文件数 / 总字节 / 聚合 SHA，不记录文件名，避免把用户数据带进仓库。
   `--write` 先打印「这一块现在有几条 / 多少字节、将被换成什么」，没点名环境变量就拒绝落盘 ——
   它盯的是真实 `.data`、`.renders` 与库根本体，一次手滑就把「用户数据没了」写成新的绿。
   ⚠ 写入型 / 读真实 .data/.renders 与库根本体的判据：不进 all.cjs 的并发池
   （串行白名单点名了这一份），只手工跑。
   以前 2.3s，慢点在「一个线程逐文件 readFileSync + sha256」——真实资产库 ~800MB
   就是 CPU 墙。现在逐文件的读与哈希分给 worker_threads 池（默认 min(4, 核数)），主线程只按
   **原来的顺序**（路径排序）把 per-file 摘要喂进聚合哈希 —— 聚合口径一字未动，产出的 sha256
   与旧逐文件串行版逐字节相同；文件少的时候退回同步路径，不为几条小文件付出起 worker 的开销。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const root = path.resolve(__dirname, '..');
const BASE = path.join(__dirname, 'data-baseline.json');
const WRITE = process.argv.includes('--write');
const WRITE_OK = process.env.DATA_SNAPSHOT_WRITE === '1';
/* 盯哪几块数据：
     · `.data` —— 设置、任务记录、本机资产**账**（.data\local-assets\）；
     · `.renders` —— FCPXML 媒体包；
     · 库根那一份**产物本体**（默认 系统下载\成像，在仓库外）—— 基线里只记「库根」这一个标签，
       不把用户的绝对路径写进仓库（这一份文件是要提交的）。
   以前第三块是项目里的 `.assets\`：本体现在住在库根的类型子目录里，
   所以盯的必须是搬完之后的那一个根 ——「整目录没了」在这里照红，那是用户产物消失的信号。 */
const { localRootOf } = require('../server/local-root.js');
const LIB_LABEL = '库根';
const DIRS = new Map([
  ['.data', path.join(root, '.data')],
  ['.renders', path.join(root, '.renders')],
  [LIB_LABEL, localRootOf(root, path.join(root, process.env.DATA_DIR || '.data'))],
]);
/* 少于这么多文件就不值得起 worker 池（启动 + 通信开销约 80-120ms 就能盖过收益）。 */
const PARALLEL_MIN_FILES = 12;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}
function hashOne(p) {
  const b = fs.readFileSync(p);
  return { len: b.length, sha: crypto.createHash('sha256').update(b).digest('hex') };
}

const WORKER_SRC = [
  'const { parentPort } = require("worker_threads");',
  'const fs = require("fs"), crypto = require("crypto");',
  'parentPort.on("message", m => {',
  '  if (!m) return;',
  '  try { const b = fs.readFileSync(m.p);',
  '    parentPort.postMessage({ id: m.id, len: b.length, sha: crypto.createHash("sha256").update(b).digest("hex") });',
  '  } catch (e) { parentPort.postMessage({ id: m.id, error: String(e && e.message || e) }); }',
  '});',
].join('\n');

/* 把 files 均匀摊给 n 个 worker；返回与入参同序的 [{len, sha}]。出错照实抛，不静默。 */
async function hashParallel(files) {
  const n = Math.max(1, Math.min(4, os.cpus().length, Math.ceil(files.length / 2)));
  const results = new Array(files.length);
  const queues = Array.from({ length: n }, () => []);
  files.forEach((f, i) => queues[i % n].push(i));
  const workers = [];
  await new Promise((resolve, reject) => {
    let pending = files.length;
    const send = (w, i) => w.postMessage({ id: i, p: files[i] });
    for (let k = 0; k < n; k++) {
      const w = new Worker(WORKER_SRC, { eval: true });
      workers.push(w);
      let qi = 0;
      const feed = () => {
        while (qi < queues[k].length && (w._inflight || 0) < 2) {   // 每人最多压两条，让结果别一次性堆内存
          w._inflight = (w._inflight || 0) + 1;
          send(w, queues[k][qi++]);
        }
      };
      w.on('message', m => {
        w._inflight = Math.max(0, (w._inflight || 1) - 1);
        if (m && m.error) return reject(new Error(m.error));
        results[m.id] = { len: m.len, sha: m.sha };
        if (--pending <= 0) return resolve();
        feed();
      });
      w.on('error', reject);
      w.on('exit', code => { if (code !== 0 && pending) reject(new Error('worker 提前退出（' + code + '）')); });
      feed();
    }
  });
  await Promise.all(workers.map(w => w.terminate().catch(() => {})));
  return results;
}

async function snapshot(label, dir) {
  const files = walk(dir).sort();
  const h = crypto.createHash('sha256');
  let bytes = 0;
  const hashes = files.length >= PARALLEL_MIN_FILES ? await hashParallel(files) : files.map(f => hashOne(f));
  for (let i = 0; i < files.length; i++) {
    const r = path.relative(dir, files[i]).replace(/\\/g, '/');
    const { len, sha } = hashes[i];
    bytes += len;
    h.update(r + '\0' + len + '\0');
    h.update(Buffer.from(sha, 'hex'));        // 与旧版 update(digestBuffer) 逐字节等价
  }
  return { dir: label, files: files.length, bytes, sha256: h.digest('hex') };
}

function oldDirs() {
  if (!fs.existsSync(BASE)) return null;
  try { return JSON.parse(fs.readFileSync(BASE, 'utf8')).dirs; } catch (e) { return null; }
}
/* 逐块比对：基线里有没有这一块、这一块现在变没变。两个出口（比对 / 重打）都读它，
   省得「哪里变了」这套判据在一份文件里写两遍。 */
function diffRows(old, cur) {
  return [...DIRS.keys()].map(d => {
    const a = old && old[d], b = cur[d];
    return {
      d, a, b,
      none: !a,
      changed: !!a && (a.sha256 !== b.sha256 || a.files !== b.files || a.bytes !== b.bytes),
    };
  });
}

(async () => {
  const entries = await Promise.all([...DIRS].map(async ([label, dir]) => [label, await snapshot(label, dir)]));
  const cur = Object.fromEntries(entries);
  console.log(JSON.stringify(cur, null, 2));
  const old = oldDirs();
  if (WRITE) {
    console.log('\n这一份会被换成新的基线：');
    for (const r of diffRows(old, cur)) {
      if (r.none) console.log('  + ' + r.d + '：基线里还没有这一块，现在 ' + r.b.files + ' 个文件 / ' + r.b.bytes + ' 字节');
      else if (r.changed) console.log('  ~ ' + r.d + '：' + r.a.files + '→' + r.b.files + ' 个文件，' + r.a.bytes + '→' + r.b.bytes + ' 字节');
      else console.log('  = ' + r.d + ' 未变');
    }
    if (!WRITE_OK) {
      console.error('\n✗ 没有落盘：重打基线要显式确认 —— DATA_SNAPSHOT_WRITE=1 node tests/data-snapshot.cjs --write');
      process.exit(1);
    }
    fs.writeFileSync(BASE, JSON.stringify({ version: 1, at: new Date().toISOString(), dirs: cur }, null, 2) + '\n');
    console.log('\n已写入 tests/data-baseline.json');
  } else if (old) {
    let bad = 0;
    for (const r of diffRows(old, cur)) {
      if (r.none) { console.log('  - ' + r.d + ' 无基线（第一次跑，或这一块是刚纳入盯的）'); continue; }
      if (r.changed) {
        bad++;
        console.log('  ✗ ' + r.d + ' 变了：' + r.a.files + '→' + r.b.files + ' 个文件，' + r.a.bytes + '→' + r.b.bytes + ' 字节');
      } else console.log('  ✓ ' + r.d + ' 未变');
    }
    process.exit(bad ? 1 : 0);
  }
})().catch(e => { console.error('✗ 基线判据自己坏了：' + (e && e.stack || e)); process.exit(1); });
