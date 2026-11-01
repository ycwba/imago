#!/usr/bin/env node
/* 库根「本体住在哪儿」那一条算法的常驻回归（纯 Node，不启浏览器；除「旧库根一次性改名」外
   不写用户任何真实目录）。跑法：`node tests/local-root.cjs`。

   这一条为什么值得单独守着：它坏了**不报错**。设置页那一格填了新目录、代理还算老根，
   现象只是「改了位置、产物还往老地方写」，而账（.data\\local-assets\\）照旧跟着应用走 ——
   用户看不出任何异常，只有翻盘的时候才发现作品不在自己挑的地方。

   盘上那份的形状不是服务端定的：`PUT /data/<键>` 把浏览器发的正文一字不改写进 `<键>.json`，
   正文 = localStorage 里那个键的原值。页面这一路走 `window.LS.set`，所以常态是**裸文本**
   （`D:\作品`，没有引号、不是 JSON —— 与 `.data\\ai_chat_w.json` 里那一份 `360` 同一种形状）；
   换成 `Store.set` 的那一路才是信封 `{"data":…,"ts":…}`。读的一侧曾经只会 JSON.parse 并猜
   `value` / `dir` 两种没有任何写入方会产生的形状，于是裸文本那份当场 parse 失败、静默回落默认根。
   这里就把「写侧真实会写出的形状」钉成判据。 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { localRootOf, defaultLocalDir } = require('../server/local-root.js');
const userDirs = require('../server/user-dirs.js');

const ROOT = path.resolve(__dirname, '..');
let bad = 0, n = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-root-probe-'));
/* 一个只有测试认识的目录名（带中文与反斜杠，免得判据只在「恰好是合法 JSON」时才是绿的）。 */
const WANT = path.resolve(tmp, '作品\\挑的这一格');
const withFile = (body) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'data-'));
  if (body !== null) fs.writeFileSync(path.join(dir, 'sk_local_dir.json'), body, 'utf8');
  return dir;
};

try {
  /* ① 写侧真实会写出的那一种：裸文本 */
  ok('裸文本（window.LS.set 那一形状）算的就是那一格',
    localRootOf(ROOT, withFile(WANT)) === WANT, 'got ' + localRootOf(ROOT, withFile(WANT)));
  /* ② 有人以后改用 setJson：JSON 字符串形状 */
  ok('JSON 字符串形状也算同一个根',
    localRootOf(ROOT, withFile(JSON.stringify(WANT))) === WANT);
  /* ③ Store 的信封形状 */
  ok('Store 信封 {data,ts} 取 data',
    localRootOf(ROOT, withFile(JSON.stringify({ data: WANT, ts: 1 }))) === WANT);
  /* ④ 回落默认的那几档：没这个文件 / 空串 / 只有空白 */
  const DEF = defaultLocalDir(ROOT);
  ok('没有这一份文件 = 那一格没填，回落默认根', localRootOf(ROOT, withFile(null)) === DEF);
  ok('空串回落默认根（页面清空那一格时把键删掉，这里守后半段）', localRootOf(ROOT, withFile('')) === DEF);
  ok('只有空白回落默认根', localRootOf(ROOT, withFile('   \r\n')) === DEF);
  /* ⑤ 没有任何写入方会产生的形状：不许照着它算，也不许拼成 [object Object] 那种项目根下的怪目录 */
  const junk = localRootOf(ROOT, withFile(JSON.stringify({ value: WANT })));
  ok('凭空猜的形状（value / dir）不当「配过」', junk === DEF, 'got ' + junk);
  const junk2 = localRootOf(ROOT, withFile(JSON.stringify({ list: [1, 2] })));
  ok('非字符串的 JSON 不当「配过」', junk2 === DEF, 'got ' + junk2);
  /* ⑥ 默认根跟着系统下载文件夹走（不是写死的 HOME\\Downloads） */
  ok('默认根 = 系统下载\\成像', DEF === path.join(userDirs.systemDownloadsDir(), '成像'), 'got ' + DEF);
  /* ⑦ 环境变量压过镜像：隔离验证实例靠这一条，指错就等于探针写进用户作品 */
  const saved = process.env.ASSETS_DIR;
  try {
    const probeAbs = path.resolve(tmp, '探针假根');
    process.env.ASSETS_DIR = probeAbs;
    ok('ASSETS_DIR（绝对）压过盘上那一格', localRootOf(ROOT, withFile(WANT)) === probeAbs);
    process.env.ASSETS_DIR = '.assets-probe';
    ok('ASSETS_DIR（相对）按项目根解析，不是按进程当前目录',
      localRootOf(ROOT, withFile(WANT)) === path.resolve(ROOT, '.assets-probe'));
  } finally {
    if (saved === undefined) delete process.env.ASSETS_DIR; else process.env.ASSETS_DIR = saved;
  }
  ok('环境变量撤掉后回到盘上那一格', localRootOf(ROOT, withFile(WANT)) === WANT);
  /* ⑧ 整轮里没有一次算出过 [object —— 那一级是「在项目根下新建一个怪目录」的前置 */
  ok('任何形状都不把根算成 [object Object]',
    !/object Object/i.test(localRootOf(ROOT, withFile(JSON.stringify({ x: 1 })))));
  /* ⑨ 一次性搬迁：旧根在、新根不在 → 整体改名，文件跟着走。
     用探针口（AUTOSAVE_DIR）指到临时基座，绝不碰用户的 下载。 */
  const freshUserDirs = () => {
    delete require.cache[require.resolve('../server/user-dirs.js')];
    return require('../server/user-dirs.js');
  };
  const savedAutosave = process.env.AUTOSAVE_DIR;
  try {
    const oldBase = path.resolve(tmp, '旧基座');
    fs.mkdirSync(path.join(oldBase, '拾帧', '提示词'), { recursive: true });
    fs.writeFileSync(path.join(oldBase, '拾帧', '提示词', 'a.md'), 'x', 'utf8');
    process.env.AUTOSAVE_DIR = oldBase;
    const moved = freshUserDirs().downloadsRoot();
    ok('旧根整体迁到 成像', moved === path.join(oldBase, '成像'), 'got ' + moved);
    ok('迁移后旧根消失、归档文件跟着走',
      !fs.existsSync(path.join(oldBase, '拾帧'))
      && fs.readFileSync(path.join(oldBase, '成像', '提示词', 'a.md'), 'utf8') === 'x');
    /* ⑩ 两个根并存：新根已经有人用，就不动旧根 */
    const bothBase = path.resolve(tmp, '并存基座');
    fs.mkdirSync(path.join(bothBase, '拾帧'), { recursive: true });
    fs.mkdirSync(path.join(bothBase, '成像'), { recursive: true });
    process.env.AUTOSAVE_DIR = bothBase;
    const stayed = freshUserDirs().downloadsRoot();
    ok('两根并存时用新根、不动旧根', stayed === path.join(bothBase, '成像')
      && fs.existsSync(path.join(bothBase, '拾帧')), 'got ' + stayed);
  } finally {
    if (savedAutosave === undefined) delete process.env.AUTOSAVE_DIR; else process.env.AUTOSAVE_DIR = savedAutosave;
  }
} catch (e) {
  bad++; console.log('  ✗ 判据本身抛出：' + ((e && e.message) || e));
  if (e && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log((bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过（库根那一条算法）');
process.exit(bad ? 1 : 0);
