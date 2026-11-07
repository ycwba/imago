#!/usr/bin/env node
/* 覆盖前那一份备份的判据（「最少 10 分钟」那一句）。
   跑法：`node tests/fs-atomic.cjs`。只在系统临时目录里写，不碰 `.data` 与库根。

   这一条为什么值得单独守着：备份是**唯一那份**。`server/data-hub.js` 的 writeJsonWithBak
   管的是 .data/asr.json 与 .data/search.json —— 里面装的是识别与搜索的密钥。少了窗口，
   「连错两次」之后连线索都没了；而窗口若只在某一路径上生效，同一个约定就变成两把尺子。
   这里钉的是那一份判据：换内容才留、留了至少 10 分钟、备份写不成就不许覆盖。 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeJsonWithBak, backupBeforeOverwrite, bakFileOf, BAK_KEEP_MS } = require('../server/data-hub.js');

let bad = 0, n = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) { console.log('  ✓ ' + name); return; }
  bad++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-probe-'));
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const touch = (dir, obj) => {
  const file = path.join(dir, 'x.json'), bak = bakFileOf(file);
  writeJsonWithBak(file, obj);
  return { file, bak };
};

try {
  ok('窗口是一枚常量（10 分钟）', BAK_KEEP_MS === 10 * 60 * 1000, 'got ' + BAK_KEEP_MS);
  ok('备份名只有一种拼法', bakFileOf(path.join('a', 'b.json')) === path.join('a', 'b.bak.json'));

  /* ① 第一次覆盖留一份旧内容 */
  const d1 = fs.mkdtempSync(path.join(tmp, 'first-'));
  const a = touch(d1, { v: 1 });
  ok('第一次写没有备份（本来就没有旧内容）', read(a.bak) === null);
  touch(d1, { v: 2 });
  ok('覆盖之后 .bak 里是改之前那一份', JSON.parse(read(a.bak)).v === 1, 'got ' + read(a.bak));
  ok('正主换成了新内容', JSON.parse(read(a.file)).v === 2);

  /* ② 同内容重复写不新增、也不动备份 */
  const bakAt1 = read(a.bak);
  touch(d1, { v: 2 });
  ok('内容一模一样时不重写备份', read(a.bak) === bakAt1);

  /* ③ 窗口内第二次误写不许把唯一那份好数据顶掉 */
  touch(d1, { v: 3 });
  ok('10 分钟内再改一次，备份还是最早那一份', JSON.parse(read(a.bak)).v === 1,
    'got ' + read(a.bak));

  /* ④ 窗口过后才换，并且换成「上一次的正主」 */
  const d2 = fs.mkdtempSync(path.join(tmp, 'aged-'));
  const b = touch(d2, { v: 1 });
  touch(d2, { v: 2 });                       // bak = v1（此刻在窗口里，后面那次改不动它）
  fs.utimesSync(b.bak, new Date(Date.now() - BAK_KEEP_MS - 1000), new Date(Date.now() - BAK_KEEP_MS - 1000));
  touch(d2, { v: 3 });
  ok('备份过了 10 分钟才允许被换', JSON.parse(read(b.bak)).v === 2, 'got ' + read(b.bak));

  /* ⑤ 窗口已经过了，但备份里存的就是「旧内容」那一份：不白写一次 */
  const bakBody = read(b.file);
  fs.writeFileSync(b.bak, bakBody, 'utf8');   // 把 bak 摆成和正主（旧内容）一模一样
  fs.utimesSync(b.bak, new Date(Date.now() - BAK_KEEP_MS - 1000), new Date(Date.now() - BAK_KEEP_MS - 1000));
  const stBefore = fs.statSync(b.bak).mtimeMs;
  touch(d2, { v: 5 });
  ok('备份内容与旧内容相同时不重写', fs.statSync(b.bak).mtimeMs === stBefore && read(b.bak) === bakBody,
    '重写过了');

  /* ⑥ 文件还不存在 = 「无需备份」，不是失败 */
  const d3 = fs.mkdtempSync(path.join(tmp, 'absent-'));
  const freshFile = path.join(d3, 'new.json');
  let threw = '';
  try { backupBeforeOverwrite(freshFile, bakFileOf(freshFile), '{"a":1}'); } catch (e) { threw = e.message; }
  ok('旧文件不在时不报「备份失败」', threw === '', 'got ' + threw);
  ok('旧文件不在时不凭空建出备份', !fs.existsSync(bakFileOf(freshFile)));

  /* ⑦ 备份写不成就不许覆盖（磁盘满 / 被占用那一类）：以前这一支被静默吞掉，
       表现是「保存成功了，但那份好数据再也没有备份」 */
  const d4 = fs.mkdtempSync(path.join(tmp, 'fails-'));
  const c = touch(d4, { v: 1 });
  touch(d4, { v: 2 });
  const goodFile = read(c.file);
  const realWrite = fs.writeFileSync;
  fs.utimesSync(c.bak, new Date(Date.now() - BAK_KEEP_MS - 1000), new Date(Date.now() - BAK_KEEP_MS - 1000));
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).includes('.bak.json')) { const e = new Error('mock: 盘满'); e.code = 'ENOSPC'; throw e; }
    return realWrite(p, ...rest);
  };
  let why = '';
  try { writeJsonWithBak(c.file, { v: 999 }); } catch (e) { why = e.message; } finally { fs.writeFileSync = realWrite; }
  ok('备份写不成时报错而不是照覆盖', !!why, '没抛错');
  ok('备份写不成时正主一个字节都没变', read(c.file) === goodFile, 'got ' + read(c.file));

  /* ⑧ 备份那份自己不再备份（否则 .bak.bak.json 一路攒下去） */
  const d5 = fs.mkdtempSync(path.join(tmp, 'bak-'));
  const bakOnly = path.join(d5, 'w.bak.json');
  fs.writeFileSync(bakOnly, '{"old":true}', 'utf8');
  backupBeforeOverwrite(bakOnly, path.join(d5, 'w.bak.bak.json'), '{"new":true}');
  ok('覆盖备份本身时不再造下一层备份', !fs.existsSync(path.join(d5, 'w.bak.bak.json')));
  ok('覆盖备份本身不抛错', read(bakOnly) === '{"old":true}');
} catch (e) {
  bad++; console.log('  ✗ 判据本身抛出：' + ((e && e.message) || e));
  if (e && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log((bad ? '✗ ' : '✓ ') + n + ' 项，' + bad + ' 项未通过（覆盖前那一份备份）');
process.exit(bad ? 1 : 0);
