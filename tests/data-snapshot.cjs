#!/usr/bin/env node
/* 用户数据基线 —— 跑法：`node tests/data-snapshot.cjs [--write]`
   只记录每个目录的文件数 / 总字节 / 聚合 SHA，不记录文件名，避免把用户数据带进仓库。
   --write 写 tests/data-baseline.json；不带参数时与基线比对（只读，不修改）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const BASE = path.join(__dirname, 'data-baseline.json');
const WRITE = process.argv.includes('--write');
const DIRS = ['.data', '.assets', '.renders'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}
function snapshot(dir) {
  const rel = path.relative(root, dir).replace(/\\/g, '/');
  const files = walk(dir).sort();
  const h = crypto.createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    const r = path.relative(dir, f).replace(/\\/g, '/');
    const b = fs.readFileSync(f);
    bytes += b.length;
    h.update(r + '\0' + b.length + '\0');
    h.update(crypto.createHash('sha256').update(b).digest());
  }
  return { dir: rel, files: files.length, bytes, sha256: h.digest('hex') };
}
const cur = Object.fromEntries(DIRS.map(d => [d, snapshot(path.join(root, d))]));
console.log(JSON.stringify(cur, null, 2));
if (WRITE) {
  fs.writeFileSync(BASE, JSON.stringify({ version: 1, at: new Date().toISOString(), dirs: cur }, null, 2) + '\n');
  console.log('\n已写入 tests/data-baseline.json');
} else if (fs.existsSync(BASE)) {
  let old = null;
  try { old = JSON.parse(fs.readFileSync(BASE, 'utf8')).dirs; } catch (e) {}
  let bad = 0;
  for (const d of DIRS) {
    const a = old && old[d], b = cur[d];
    if (!a) { console.log('  - ' + d + ' 无基线'); continue; }
    if (a.sha256 !== b.sha256 || a.files !== b.files || a.bytes !== b.bytes) {
      bad++;
      console.log('  ✗ ' + d + ' 变了：' + a.files + '→' + b.files + ' 个文件，' + a.bytes + '→' + b.bytes + ' 字节');
    } else console.log('  ✓ ' + d + ' 未变');
  }
  process.exit(bad ? 1 : 0);
}
