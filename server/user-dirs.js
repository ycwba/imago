/* 用户可见的本机目录根 —— 只有这一份。
   「下载\成像」是共用一个根：图片\ / 视频\ / 音频\ / 其他\ = 产物本体（库根按类型分），
   提示词\ = 归档（.md）。两边各写各的子目录，互不覆盖。 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

/* 系统默认的「下载」文件夹。**不要**直接用 %USERPROFILE%\Downloads 猜 ——
   用户可以把它搬到别的盘（D:\下载），那件事记在注册表里：
   HKCU\...\Explorer\Shell Folders 的
   {374DE290-123F-4565-9164-39C4925E467B}（Downloads 的 KNOWNFOLDERID 固定 GUID）。
   问一次就缓存：每一次落盘都要问一次根，reg.exe 一次上百毫秒。
   问不到（不是 Windows / 注册表没这一项 / reg 被拦）就退到 homedir\Downloads。 */
let systemDownloadsCache = null;
function systemDownloadsDir() {
  if (systemDownloadsCache) return systemDownloadsCache;
  /* 探针（隔离实例）用 AUTOSAVE_DIR 把整个「下载」基座指走 —— 指了就一口价，不再问注册表。 */
  const forced = String(process.env.AUTOSAVE_DIR || '').trim();
  if (forced) { systemDownloadsCache = path.resolve(forced); return systemDownloadsCache; }
  let dir = '';
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('reg', ['query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
        { encoding: 'utf8', windowsHide: true });
      const m = r && r.stdout && r.stdout.match(/REG_SZ\s+(\S.*)/);
      if (m && m[1].trim()) dir = m[1].trim();
    }
  } catch {}
  if (!dir) dir = path.join(os.homedir(), 'Downloads');
  /* 注册表里可能是 REG_EXPAND_SZ（值里带 %USERPROFILE% 之类）—— reg query 不给展开，自己展开一层 */
  dir = dir.replace(/%([^%]+)%/g, (s, n) => process.env[n] || s);
  systemDownloadsCache = path.resolve(dir);
  return systemDownloadsCache;
}

const AUTOSAVE_TOP_DIR = '成像';
const LEGACY_TOP_DIR = '拾帧';
/* 提示词归档在库根下那一档的名字。只要名字的地方读这一枚，不要为了拿个名字去走 downloadsRoot()
   —— 那个函数会动盘（见下面的一次性搬迁），只该由「这一份就是默认根」的解析路径调。 */
const PROMPTS_DIR_NAME = '提示词';
/* 一次性搬迁：默认库根从 下载\拾帧 整体改名到 下载\成像（同卷 rename，提示词归档跟着走，
   账里的 fid / 相对路径认回不受影响）。改名没成（目录被占用）就本次继续用旧根并记一笔，
   下次启动重试 —— 绝不静默指到一个空的新根。
   ⚠ 这一条会动用户成品所在的目录，所以两种「看起来已经搬完了」的情况必须分开判：
     · 新根**存在但不是目录**（同步盘留下的占位文件、误建的同名文件）：existsSync 会把它读成
       「已迁移」，于是整个库根变成一个普通文件 —— 扫得到的是空库，每个 mkdirSync 抛 ENOTDIR，
       而一句日志都没有。这一档必须认出来；而且**不许拿改名去顶掉它**（Windows 上
       renameSync(目录, 已存在的文件) 真会替换目标，那是为了搬库根删掉用户盘上的东西）。
     · 另一个实例刚刚搬完（server/lock.js 只按 DATA_DIR 上锁，两份实例共用同一个「下载」基座时
       这一步没有闸）：这边 renameSync 抛 ENOENT / EEXIST。按 e.code 一律回退旧根就等于把
       「别人已经搬完」当成「这一份被占用」，回退到一个已经不存在的目录；随后 mkdirSync 重新建出
       空的 下载\拾帧，新产物落进被放弃的那一份 —— 一个库裂成两个根。
   所以判定只看 statSync().isDirectory()，失败后**先重读一遍两个根再决定用谁**。 */
let resolvedRoot = null;
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
/* 这一次该用哪个根（只判不改名）：新根是目录就用新根；旧根还是目录就退回旧根；
   两个都不是目录就是「还没建过」，按新根走（下一次 mkdirSync 建它）。 */
function pickRoot(root, old) {
  if (isDir(root)) return root;
  if (isDir(old)) return old;
  return root;
}
function resolveRoot() {
  if (resolvedRoot) return resolvedRoot;
  const root = path.join(systemDownloadsDir(), AUTOSAVE_TOP_DIR);
  const old = path.join(path.dirname(root), LEGACY_TOP_DIR);
  if (isDir(root)) { resolvedRoot = root; return resolvedRoot; }
  if (!isDir(old)) {
    /* 旧根不在：没有东西要搬。新根那一个若是**文件**，指过去就是上面说的静默空库，
       但此时旧根也没有产物可救 —— 照实报一句，让写盘那一路去抛它自己的错。 */
    if (fs.existsSync(root)) console.log('[user-dirs] ' + root + ' 占着但不是目录，库根没建成（先把它挪走再重启）');
    resolvedRoot = root;
    return resolvedRoot;
  }
  if (fs.existsSync(root)) {
    /* 旧根有产物、新根却被一个文件占着：这时候**不能**改名 —— Windows 上
       renameSync(目录, 已存在的文件) 会把那一个文件顶掉，等于为了搬库根删掉用户盘上的东西。
       本次继续用旧根，界面上什么都没坏；把那一个文件挪走再重启就能迁过去。 */
    console.log('[user-dirs] ' + root + ' 占着但不是目录，旧库根没改名（把它挪走再重启就能迁过去）');
    resolvedRoot = old;
    return resolvedRoot;
  }
  try {
    fs.renameSync(old, root);
    console.log('[user-dirs] 库根已整体迁到 ' + root);
    resolvedRoot = root;
  } catch (e) {
    const code = (e && e.code) || e;
    const now = pickRoot(root, old);
    if (now === root) {
      /* 重读发现新根已经是目录了：就是另一个实例搬完的那一种，别把用户往旧根上引。 */
      console.log('[user-dirs] 旧库根已由别处迁到 ' + root + '（本次改名报 ' + code + '）');
    } else {
      console.log('[user-dirs] 旧库根迁移没成（' + code + '），本次继续用 ' + now);
    }
    resolvedRoot = now;
  }
  return resolvedRoot;
}
/* 默认库根（会做上面那一次性搬迁，一个进程只判一次）。 */
const downloadsRoot = () => resolveRoot();
/* 归档第四类：成像\提示词（.md 归档不混进媒体堆） */
const promptsRoot = () => path.join(downloadsRoot(), PROMPTS_DIR_NAME);

module.exports = { systemDownloadsDir, downloadsRoot, promptsRoot, AUTOSAVE_TOP_DIR, PROMPTS_DIR_NAME };
