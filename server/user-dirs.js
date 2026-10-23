/* 用户可见的本机目录根 —— 只有这一份。
   「下载\拾帧」是共用一个根：图片\ / 视频\ / 音频\ / 其他\ = 产物本体（库根按类型分），
   提示词\ = 归档（.md）。两边各写各的子目录，互不覆盖。 */
'use strict';
const path = require('path');
const os = require('os');
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

const AUTOSAVE_TOP_DIR = '拾帧';
/* 共用根：下载\拾帧 */
const downloadsRoot = () => path.join(systemDownloadsDir(), AUTOSAVE_TOP_DIR);
/* 归档第四类：下载\拾帧\提示词（.md 归档不混进媒体堆） */
const promptsRoot = () => path.join(downloadsRoot(), '提示词');

module.exports = { systemDownloadsDir, downloadsRoot, promptsRoot, AUTOSAVE_TOP_DIR };
