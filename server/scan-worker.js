'use strict';
/* 库根磁盘对账的走树件（worker_threads）。
   ---------------------------------------------------------------------------
   为什么单独一个文件：dirScan 的递归 readdir + stat(bigint) 是整站最重的一段盘上活
   （几百条本体就是几百次 syscall，跑在主线程上时别的请求全排着）。把它放进一条
   **专用线程**：主线程发一个根路径、收一份文件行，期间事件循环照常跑。
   worker 不碰账（index-store）、不碰账本目录，只有只读的 readdir / stat。
   walkTree 是**唯一**一份走树算法：worker 模式吃它；主线程在 worker 起不来 / 崩了时
   也 require 同一枚函数当兜底（同一条算法的同一份实现，不是另抄的一套）。
   跳过的目录与 local-assets-store 同源（user-dirs 的三个名字），两处各从 user-dirs 取，
   不许任何一边手抄名单。 */
const fs = require('fs');
const path = require('path');
const userDirs = require('./user-dirs.js');

const SKIP_DIR_NAMES = new Set([userDirs.PROMPTS_DIR_NAME, userDirs.FCPXML_PROJECT_DIR, '.trash']);
/* fid = `<dev>:<ino>`，都取字符串（bigint stat 的两个 BigInt 拼接）。
   全站只有这一处算法（scan-worker 与 local-assets-store 都从这份 require）：
   必须用 { bigint: true } 那一次 stat —— 普通 statSync 交回来的是已经丢过精度的 double
   （NTFS 的 ino 真能超过 2^53），同一文件的两条账就会算出两个号，
   「落盘那一条与磁盘对账那一条」在②那一级永远对不上。 */
const fidOfStat = st => String(st.dev) + ':' + String(st.ino);

function walkTree(root) {
  const files = [];
  const scanTree = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const name of entries.map(e => e.name)) {
      if (rel === '' && SKIP_DIR_NAMES.has(name)) continue;
      const abs = path.join(dir, name);
      const relPath = rel ? rel + path.sep + name : name;
      let st;
      try { st = fs.statSync(abs, { bigint: true }); } catch { continue; }
      if (st.isDirectory()) { scanTree(abs, relPath); continue; }
      if (!st.isFile()) continue;
      files.push({ rel: relPath, abs, size: Number(st.size), mtimeMs: Number(st.mtimeMs), fid: fidOfStat(st), sig: '' });
    }
  };
  scanTree(root, '');
  return files;
}

module.exports = { walkTree, fidOfStat };

/* 被 new Worker(...) 直接加载时这一句才成立：进入 worker 模式，按消息逐个扫根。
   被 local-assets-store require 时 require.main 是进程主模块，不会走进这一支。 */
if (require.main === module) {
  const { parentPort } = require('worker_threads');
  parentPort.on('message', m => {
    try { parentPort.postMessage({ id: m.id, files: walkTree(String((m && m.root) || '')) }); }
    catch (e) { parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) }); }
  });
}
