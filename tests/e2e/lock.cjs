#!/usr/bin/env node
/* 单实例锁：同一 DATA_DIR 起第二个代理必须拒绝启动，第一个不受影响。 */
'use strict';
const cp = require('child_process');
const path = require('path');
const h = require('./harness.cjs');

(async () => {
  let first = null;
  try {
    first = await h.startProxy();
    const secondPort = await new Promise((resolve, reject) => {
      const net = require('net');
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const out = [];
    const p = cp.spawn(process.execPath, ['proxy.js'], {
      cwd: h.root,
      env: { ...process.env, PORT: String(secondPort), DATA_DIR: first.dataDir, ASSETS_DIR: first.assetsDir, RENDER_DIR: first.renderDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', b => out.push(b.toString()));
    p.stderr.on('data', b => out.push(b.toString()));
    const code = await new Promise(resolve => {
      p.on('exit', resolve);
      setTimeout(() => { try { p.kill(); } catch (e) {} resolve('timeout'); }, 10000);
    });
    if (code === 0 || code === 'timeout') throw new Error('第二个实例没有被拒绝：' + code + '\n' + out.join(''));
    if (!/数据目录已经有一个代理在跑/.test(out.join(''))) throw new Error('拒绝原因不清楚：\n' + out.join(''));
    const r = await fetch(first.base + '/sys-status', { headers: { cookie: first.cookie } });
    if (r.status !== 200) throw new Error('第一个实例被影响：HTTP ' + r.status);
    console.log('✓ 单实例锁通过');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (first) await first.stop();
  }
})();
