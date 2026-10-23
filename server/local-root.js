/* 本机资产库「本体根」怎么算 —— 只有这一处。
   代理与磁盘对账（tests/data-snapshot.cjs）读的必须是同一个口径：
   算错根就等于去读一个代理根本不写的地方，界面上的现象是「资产库空了」。

   优先级（AGENTS §1）：
     ① ASSETS_DIR 环境变量 —— 隔离验证实例靠它指出去，否则 headless 探针生成的素材会直接写进用户那份；
     ② .data/sk_local_dir.json —— 设置页「本机资产库」那一格配的（页面写 localStorage，DataSync 镜像到盘上）；
     ③ 默认 = 系统下载\拾帧（路径本身在 server/user-dirs.js，全站唯一）。
   ②③ 每次现读，改位置不必重启代理。
   ⚠ 换根之后旧根里的文件不会自己跟过去：账（.data\local-assets\）跟着应用走，本体留在原来那块盘上，
     于是旧根那些产物在库里读不到文件 —— 代理只扫**当前**根，界面上如实显示「文件不在了」，
     回源外链与费用记录照样在。要接着用旧根那些字节，就把文件管理器里的整个旧根搬进新根。 */
'use strict';
const fs = require('fs');
const path = require('path');
const userDirs = require('./user-dirs.js');

/* 设置页那一格在 .data 里的键名（DataSync 把 localStorage 同名键原样镜像成 <键>.json）。 */
const LOCAL_DIR_KEY = 'sk_local_dir';

/* 形参一律小写：`ROOT` 这种写法在本文件里是一个参数，可代理的路由审计（tests/routes-smoke.cjs
   的自由变量对账）只看「本文件声明了什么」，一个与 app.js 配置同名的裸参数看起来就是漏注入的自由变量。
   环境变量里的根可以是相对项目根的那一种（探针就写 .assets-probe），所以用 path.resolve 而不是
   path.join：join 把绝对路径当相对片段拼上去（join('/a/b','C:\\x') → '/a/b/C:\\x'），
   于是照注释传一个绝对路径时，目录会静默落到一个不存在的拼接路径上。 */
function envLocalDir(projectRoot) {
  return path.resolve(projectRoot, String(process.env.ASSETS_DIR || '').trim());
}

/* 那一格在盘上长什么样：`PUT /data/<键>` 把浏览器发的正文**一字不改**写进 `<键>.json`，
   而正文就是 localStorage 里那个键的原值。页面这一路走 `window.LS.set`（裸字符串，没有引号、
   不是 JSON），所以常态是**裸文本** `D:\作品`；换成 `Store.set` 的那一路才是信封 `{"data":…,"ts":…}`。
   两种都得认 —— 「读出来当没配」在这里不会报错，它的表现是产物静默写进默认根，
   用户只看得见「改了位置没生效」。（判据：tests/local-root.cjs） */
function mirroredDir(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s[0] !== '{' && s[0] !== '"') return s;              // 裸文本：整份就是那个路径
  try {
    const j = JSON.parse(s);
    const v = (j && typeof j === 'object' && j.data !== undefined) ? j.data : j;   // 信封取 data
    return typeof v === 'string' ? v.trim() : '';          // 不是字符串 = 这一份不算配过
  } catch { return ''; }
}

/* 一次现算（给定项目根与数据目录）。dataDir 是 .data 的那一个（绝对或相对项目根）。
   环境变量排在配置前面：探针指了 ASSETS_DIR 就不能因为 .data 里留着用户真机的那一格而写进用户作品。 */
function localRootOf(projectRoot, dataDir) {
  if (String(process.env.ASSETS_DIR || '').trim()) return envLocalDir(projectRoot);
  let raw = '';
  try { raw = fs.readFileSync(path.join(dataDir, LOCAL_DIR_KEY + '.json'), 'utf8'); }
  catch { /* 文件不在 = 那一格没填；读不出也照没填走，回落默认，绝不因此罢工 */ }
  const dir = mirroredDir(raw);
  if (dir) return path.resolve(dir);
  return defaultLocalDir(projectRoot);
}

/* 默认根 = 环境变量那一份，没有就是 下载\拾帧。 */
function defaultLocalDir(projectRoot) {
  return String(process.env.ASSETS_DIR || '').trim() ? envLocalDir(projectRoot)
    : path.resolve(projectRoot, userDirs.downloadsRoot());
}

/* 给代理用的动态读法：每次调用都现读（数据目录本身也可能是环境变量指定的，交给注入的函数算）。 */
function createLocalRoot(opts) {
  const readDataDir = opts.dataDirPath;
  return function localRoot() { return localRootOf(opts.ROOT, readDataDir()); };
}

module.exports = { localRootOf, defaultLocalDir, createLocalRoot };
