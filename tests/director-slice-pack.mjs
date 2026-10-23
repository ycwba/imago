#!/usr/bin/env node
/* 切片帧的持久格式：写与读必须是同一张排布表。
   以前写端把 N 条表头排在前、读端按「表头+字节」逐帧走，第一帧之后全错位：
   盘上明明有二十几张，读出来只有两张，界面表现是「二次打开又整排重新解码」，
   而缓存写入一路 200，没有任何一处报错。这一条就是钉那个形状。 */
import assert from 'node:assert/strict';
import { packFrames, unpackFrames, SLICE_PACK_MAGIC } from '../web/director/slice-pack.js';

const bytes = n => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));

async function main() {
  assert.equal(SLICE_PACK_MAGIC, 'SLICES02');

  /* 空表：打得出来、读得回来，且不因 0 帧把后面的字节当成表头。 */
  assert.deepEqual(await unpackFrames(packFrames([])), []);
  assert.deepEqual(await unpackFrames(packFrames(null)), []);

  /* 常见的「分块写入」张数：21 张、每张字节数各不相同（错位时长度表会被读成时间戳）。 */
  const list = Array.from({ length: 21 }, (_, i) => ({ t: i * 0.5, blob: new Blob([bytes(2400 + i * 17)]) }));
  const buf = await packFrames(list).arrayBuffer();
  const back = await unpackFrames(buf);
  assert.equal(back.length, 21, '读回来的张数与写进去的不一致');
  for (let i = 0; i < list.length; i++) {
    assert.ok(Math.abs(back[i].t - i * 0.5) < 1e-9, '第 ' + i + ' 张的时刻错了：' + back[i].t);
    const got = new Uint8Array(await back[i].blob.arrayBuffer());
    assert.deepEqual(Array.from(got), Array.from(bytes(2400 + i * 17)), '第 ' + i + ' 张的字节错了');
  }

  /* 判据在 Node 里直接拿 ArrayBuffer 读（服务端回的是字节流，不是 Blob）。 */
  assert.equal((await unpackFrames(buf)).length, 21);
  assert.equal((await unpackFrames(new Uint8Array(buf))).length, 21, 'Uint8Array 视图也要能读');

  /* 旧格式（表头全在前、没有 magic）一律当没有缓存：宁可重解一遍，也不猜着读半坏的。 */
  const legacy = new ArrayBuffer(12 * 2 + 10);
  const ldv = new DataView(legacy);
  ldv.setFloat64(0, 1.5); ldv.setUint32(8, 4);
  ldv.setFloat64(12, 2.5); ldv.setUint32(20, 6);
  assert.deepEqual(await unpackFrames(legacy), [], '不认的排布必须当空表');

  /* 截断的一份：magic 对、帧数对、字节不够 —— 同样当空表，不交出半条记录。 */
  const cut = buf.slice(0, buf.byteLength - 3);
  assert.deepEqual(await unpackFrames(cut), [], '截断的记录必须当空表');
  /* 帧数写得比实际大：表头都读不全，直接空表。 */
  const fake = new Uint8Array(buf.slice(0, 24));
  new DataView(fake.buffer).setUint32(8, 9999);
  assert.deepEqual(await unpackFrames(fake.buffer), []);

  console.log('director-slice-pack: ok（21 张往返逐字节一致；旧格式/截断/谎报帧数都当空表）');
}

main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
