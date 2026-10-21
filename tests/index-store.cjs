#!/usr/bin/env node
/* server/index-store 行为判据：journal 追加 / 重启重放 / 删除 / 压缩 / 坏快照。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createIndexStore } = require('../server/index-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-index-'));
const logs = [];
const mk = () => createIndexStore({ dir, log: s => logs.push(s), max: 10 });
let s = mk();
s.write([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
assert.deepStrictEqual(s.read().map(x => x.id), ['a', 'b']);
assert.ok(fs.existsSync(path.join(dir, 'index.jsonl')));

/* 重启：重放 journal 后应看到两条，并在启动时压回快照 */
s = mk();
assert.deepStrictEqual(s.read().map(x => x.id), ['a', 'b']);

/* 删除 + 更新 */
s.write([{ id: 'a', n: 3 }]);
assert.deepStrictEqual(s.read(), [{ id: 'a', n: 3 }]);
assert.strictEqual(s.entry('b'), null);
s = mk();
assert.deepStrictEqual(s.read(), [{ id: 'a', n: 3 }]);

/* 超过上限截断 */
s.write(Array.from({ length: 20 }, (_, i) => ({ id: 'x' + i })));
assert.strictEqual(s.read().length, 10);

/* 坏快照：改名留档并按空表继续，journal 不重放 */
fs.writeFileSync(path.join(dir, 'index.json'), '{bad');
s = mk();
assert.deepStrictEqual(s.read(), []);
assert.ok(logs.some(x => /损坏/.test(x)));

/* ---------- update(fn)：跨 await 的改表排在一条队里 ----------
   这一条要判的是**写法**，不是运气：拿着 `read()` 的整表、中间 await 一下、再 `write(整表)`
   是「产物在盘上、资产库里少一条」那次的成因；换成 update(fn) 之后两次都活着。
   两段都跑：前一段把危险本身钉住（不然哪天有人把 update 退回整表写，测试照样绿）。 */
(async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-index-q-'));
  const slow = () => new Promise(r => setTimeout(r, 20));
  /* 反面：两条并发各拿一份「改动前」的整表，后落盘的那份把前一条盖掉 */
  const bad = createIndexStore({ dir: dir2, log: () => {}, max: 10 });
  bad.write([]);
  await Promise.all(['m1', 'm2'].map(async id => {
    const list = bad.read().slice();
    await slow();
    bad.putInto(list, { id });
    bad.write(list);
  }));
  assert.deepStrictEqual(bad.read().map(x => x.id), ['m2'],
    '整表读-改-写居然没互相覆盖：判据失效，这一段测不出危险写法');

  /* 正面：同两条请求走 update(fn) */
  const good = createIndexStore({ dir: dir2, log: () => {}, max: 10 });
  await Promise.all(['m1', 'm2'].map(async id => { await slow(); await good.update(list => good.putInto(list, { id })); }));
  assert.deepStrictEqual(good.read().map(x => x.id).sort(), ['m1', 'm2'],
    'update(fn) 排了队还是丢了一条');
  s = createIndexStore({ dir: dir2, log: () => {}, max: 10 });
  assert.deepStrictEqual(s.read().map(x => x.id).sort(), ['m1', 'm2'], '两条只在内存里，没落进 journal');

  /* fn 返回 false = 这一趟没东西要写（别把整表重压一遍） */
  const before = fs.readFileSync(path.join(dir2, 'index.jsonl'), 'utf8');
  assert.strictEqual(await s.update(() => false), false, '返回 false 却写了盘');
  assert.strictEqual(fs.readFileSync(path.join(dir2, 'index.jsonl'), 'utf8'), before, 'false 那一趟动了 journal');

  /* 同 id 就地替换：update 与 upsert 用的是同一条 putInto 规则，两条路都得只留一条 */
  await s.update(list => s.putInto(list, { id: 'm1', n: 2 }));
  s.upsert({ id: 'm1', n: 3 });
  assert.strictEqual(s.read().filter(x => x.id === 'm1').length, 1, '同 id 又插了一条');
  assert.strictEqual(s.entry('m1').n, 3, '两条写入口对「同一条」的理解不一样');

  /* 前面那次写盘失败不能把队堵死：后面排到的还要照跑。
     把 journal 的路径占成一个目录 —— appendFileSync 当场 EISDIR，比模拟失败更真。 */
  fs.rmSync(path.join(dir2, 'index.jsonl'), { force: true });
  fs.mkdirSync(path.join(dir2, 'index.jsonl'));
  let threw = '';
  await s.update(list => s.putInto(list, { id: 'blocker' })).catch(e => { threw = String(e.message || e); });
  assert.ok(/索引写盘失败/.test(threw), '写盘失败没有抛给调用方（调用方会回 200）');
  fs.rmSync(path.join(dir2, 'index.jsonl'), { recursive: true, force: true });
  await s.update(list => s.putInto(list, { id: 'after' }));
  assert.ok(s.entry('after'), '前一条失败把队列堵住了');

  fs.rmSync(dir2, { recursive: true, force: true });
  /* 清理 */
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ index-store 行为通过（含 update 串行队列 6 条）');
})().catch(e => { console.error('✗ index-store：' + (e && e.stack || e)); process.exit(1); });
