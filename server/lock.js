/* 单实例锁：同一个 DATA_DIR 只允许一个代理写 journal / index / .data。
   锁文件 .proxy.lock = { pid, port, started }；进程死了或锁超过 24h 才能接管。 */
'use strict';
const fs = require('fs');
const path = require('path');

const STALE_MS = 24 * 60 * 60 * 1000;
function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}
function acquire(opts = {}) {
  const dir = opts.dir;
  const port = opts.port;
  const log = opts.log || (() => {});
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.proxy.lock');
  const payload = JSON.stringify({ pid: process.pid, port, started: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx' });
      const release = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (cur && cur.pid === process.pid) fs.unlinkSync(file);
        } catch (e) {}
      };
      return { file, release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e2) {}
      const age = cur && cur.started ? Date.now() - cur.started : STALE_MS + 1;
      if (cur && alive(cur.pid) && age < STALE_MS) {
        throw new Error('这个数据目录已经有一个代理在跑（pid ' + cur.pid + '，端口 ' + cur.port + '，锁 ' + file + '）。'
          + '同一个数据目录不能同时起两个代理；要另起实例请换 DATA_DIR。');
      }
      try { fs.unlinkSync(file); log('[lock] 接管过期/已死实例的锁：' + file); } catch (e2) { throw e2; }
    }
  }
  throw new Error('拿不到单实例锁：' + file);
}
module.exports = { acquire };
