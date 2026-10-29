/* 覆盖式写盘的公共件：先写 tmp → fsync → rename，rename 被占用时指数退避重试。
   为什么必须有这一份：`.data` 与资产库根里的每个文件都在 Windows 上被第三方程序碰 ——
   杀毒扫描、索引器、OneDrive / 坚果云同步盘会在几百毫秒内占住刚写开的那个目标，
   `renameSync` 当场报 EPERM / EBUSY / EACCES。以前这些错误直接冒到调用方，
   用户看到的是「设置没保存」「索引写坏了」，而重试一次就好。
   断电那一半靠 fsync：tmp 写完不落盘就 rename，掉电后可能留下一个 0 字节的目标文件。
   本文件是**服务端唯一的原子覆盖写实现**：data-store / index-store /
   cloud-store / asr-store / search-store / skills-store 都调这里，别再各写一份 .tmp + rename。 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 值得再试一次的错误码：都是「此刻被占着」，不是「这台机器不让写」。 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MAX = 3;           // 连同第一次一共 4 次尝试
const RENAME_WAIT_MS = 20;            // 退避底数：20 → 80 → 240（最坏多花 340ms，同步路径上能接受）
/* 平台 / 文件系统不支持同步落盘的那些码：退化继续写完，但要把原因交给调用方说清。 */
const FSYNC_UNSUPPORTED = new Set(['ENOSYS', 'EINVAL', 'EBADF', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

function sleepSync(ms) {
  /* SharedArrayBuffer + Atomics.wait：真等一段时间，不用 busy-loop 把 CPU 占满 */
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 拿不到就立刻返回 */ }
}

/* 对一个路径上的文件补一次 fsync。返回 { ok, why }：
   失败只可能是「拿不到 fd / 这个文件系统不认 fsync」那一类，数据已经在盘上，
   所以这里不中止写入，但原因要能被打进日志（一句「fsync 没成」比静默退化可查）。 */
function fsyncPath(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    fs.fsyncSync(fd);
    return { ok: true, why: '' };
  } catch (e) {
    const code = (e && e.code) || '';
    if (code && !FSYNC_UNSUPPORTED.has(code)) return { ok: false, why: code };   // 真正的盘出问题
    return { ok: false, why: code || ((e && e.message) || String(e)) };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 关不上不影响已经落盘的内容 */ } }
  }
}

const tmpSuffix = () => '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);

/* rename 的退避重试单独成一件可复用的事：目录整 swap（Skill 安装那次）也要同一串脾气。
   重试的只有「此刻被占着」那几个码；ENOENT / EXDEV / ENOSPC 再试一百次也不会变好，
   照原样上抛，让调用方把真正的原因说出来。 */
function renameWithRetry(from, to) {
  let wait = RENAME_WAIT_MS;
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (!e || !RETRYABLE.has(e.code) || i >= RENAME_RETRY_MAX) throw e;
      sleepSync(wait);
      wait *= 3;
    }
  }
}

/* 原子覆盖：写 tmp → fsync → rename（占用时退避重试）→ 再 fsync 目标。
   抛出的是「这次没写成」，调用方照实回错误，不要当成成功。
   返回 { fsyncWhy }：只描述 fsync 退化原因（空 = 一路顺利）。 */
function atomicWrite(file, data, opts) {
  const o = opts || {};
  const dir = o.dir || path.dirname(file);
  if (o.mkdir !== false) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + tmpSuffix();
  let fsyncWhy = '';
  try {
    fs.writeFileSync(tmp, data);
    const f1 = fsyncPath(tmp);
    if (!f1.ok) fsyncWhy = 'tmp: ' + f1.why;
    renameWithRetry(tmp, file);
    const f2 = fsyncPath(file);
    if (!f2.ok) fsyncWhy = (fsyncWhy ? fsyncWhy + ' / ' : '') + '目标: ' + f2.why;
    return { fsyncWhy };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件本来就没了 */ }
    throw e;
  }
}

/* 覆盖写一个 JSON 文件：覆盖前把旧内容留在同名 `.bak.json`（内容相同不留）。
   备份只是回滚线索 —— 备份写不成不阻挡主写；主写失败照原样抛出。 */
function writeJsonWithBak(file, obj, opts) {
  const body = JSON.stringify(obj, null, 2);
  try {
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      if (old !== body) fs.writeFileSync(file.replace(/\.json$/, '.bak.json'), old);
    }
  } catch (e) { /* 备份写不成不阻挡主写；下面那一次才是这一单的正事 */ }
  return atomicWrite(file, body, opts);
}

module.exports = { atomicWrite, writeJsonWithBak, fsyncPath, sleepSync, renameWithRetry };
