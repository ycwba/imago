#!/usr/bin/env node
/* 代理 stdout 断了不许自旋（用户报过「程序卡住、端口在听但不回话」）。
   根因：启动器窗口一关，stdout 管道就断；`console.log` 写进断掉的管道会抛异步 EPIPE，
   那条 EPIPE 又被「未捕获异常」那个出口接住 → 它调 log() → 再写一次 → 再抛一次：**无限自旋**
   （实测一个实例 1.6 小时烧掉 800 多秒 CPU，proxy.log 刷到 1.8 MB 全是同一句）。

   这一条盯三件事：管道掐断之后
   · 进程还活着，而且**照常回话**（/sys-status 200）；
   · CPU 不再自旋（5 秒里用掉的 CPU 时间有上限）；
   · proxy.log 里不再出现 EPIPE / 未捕获异常那几行。
   它起的是隔离实例（harness），跑完删掉自己的探针目录。 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const h = require('./harness.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG = path.join(h.root, 'proxy.log');

function cpuOf(pid) {
  try {
    const s = cp.execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`], { encoding: 'utf8' });
    return parseFloat(String(s).trim()) || 0;
  } catch (e) { return 0; }
}

let n = 0;
const must = (cond, msg) => { ++n; if (!cond) throw new Error('第 ' + n + ' 项不成立：' + msg); };

(async () => {
  let proxy;
  try {
    proxy = await h.startProxy();
    const pid = proxy.proc.pid;
    const logSize0 = (() => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } })();

    /* 掐断 stdout / stderr：模拟「启动器窗口被关掉」 */
    try { proxy.proc.stdout.destroy(); } catch (e) {}
    try { proxy.proc.stderr.destroy(); } catch (e) {}

    /* 先打几笔**会写日志**的请求 —— 代理每记一条日志就往 stdout 写一行，管道断了正是在这里炸。
       （Host 不在白名单的那条路径必写一行日志；请求放在测量之前：
        不然自旋发生在测完之后，这一趟就白测了。）
       用裸 http.request 而不是 fetch：fetch 不许改 Host 头（那是 forbidden header，改了不生效）。 */
    const http = require('http');
    const badHost = () => new Promise(resolve => {
      const u = new URL(proxy.base + '/sys-status');
      let done = false;
      const fin = code => { if (!done) { done = true; resolve(code); } };
      /* 自旋起来的时候这个请求根本不会有回音 —— 所以每一笔都自带超时，
         不然判据自己挂住（挂住与红都要能看出是哪里坏了）。 */
      const timer = setTimeout(() => fin(0), 4000);
      const req = http.request({ host: u.hostname, port: u.port, path: '/sys-status',
        headers: { Host: 'not-allowed.example', cookie: proxy.cookie } }, res => {
        res.resume();
        res.on('end', () => { clearTimeout(timer); fin(res.statusCode); });
      });
      req.on('error', () => { clearTimeout(timer); fin(0); });
      req.setTimeout(4000, () => { try { req.destroy(); } catch (e) {} clearTimeout(timer); fin(0); });
      req.end();
    });
    let status = 0;
    for (let i = 0; i < 3; i++) {
      status = await badHost();
      await sleep(500);
    }

    const c0 = cpuOf(pid);
    await sleep(5000);
    const c1 = cpuOf(pid);

    must(proxy.proc.exitCode === null, '管道断了之后进程自己退出了（exitCode=' + proxy.proc.exitCode + '）');
    must(c1 - c0 < 1.5, '5 秒里烧了 ' + (c1 - c0).toFixed(2) + ' 秒 CPU —— 又是自旋');

    /* 还在回话吗（要带会话 Cookie，探针实例的 cookie 在 proxy.cookie 里） */
    let ok = 0;
    try {
      const r = await fetch(proxy.base + '/sys-status', { headers: { cookie: proxy.cookie } });
      ok = r.status;
    } catch (e) { ok = 0; }
    must(ok === 200, '管道断了之后 /sys-status 不回话（状态 ' + ok + '）');
    void status;

    /* 日志里不该再有 EPIPE 自旋 */
    let tail = '';
    try {
      const size = fs.statSync(LOG).size;
      const fd = fs.openSync(LOG, 'r');
      const len = Math.min(size - logSize0, 200000);
      const buf = Buffer.alloc(Math.max(0, len));
      if (len > 0) fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      tail = buf.toString('utf8');
    } catch (e) { tail = ''; }
    const spin = tail.split(/\r?\n/).filter(l => /EPIPE|未捕获异常/.test(l));
    must(spin.length === 0, 'proxy.log 里又出现 ' + spin.length + ' 行 EPIPE / 未捕获异常');

    console.log('✓ 代理 stdout 断了不自杀旋：进程活着 · 5 秒 CPU ' + (c1 - c0).toFixed(2)
      + 's · /sys-status 200 · 日志里 0 行 EPIPE');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exit(1);
  } finally {
    try { if (proxy) await proxy.stop(); } catch (e) {}
  }
})();
