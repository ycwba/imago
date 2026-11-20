#!/usr/bin/env node
'use strict';
const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZip, createZipToFile, crc32 } = require('../server/zip.js');

/* 同一个回读器管两只入口：中央目录逐条走，按 method 解出原文比对。 */
function readZip(zip) {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  const cdOff = zip.readUInt32LE(eocd + 16);
  const got = {};
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const off = zip.readUInt32LE(p + 42);
    const name = zip.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lhName = zip.readUInt16LE(off + 26), lhExtra = zip.readUInt16LE(off + 28);
    const data = zip.slice(off + 30 + lhName + lhExtra, off + 30 + lhName + lhExtra + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(raw.length, usize);
    assert.equal(crc32(raw), crc);
    got[name] = { method, raw };
    p += 46 + nlen + elen + clen;
  }
  return got;
}

const AT = new Date('2026-10-18T00:00:00Z');
const entries = [
  { name: 'project.fcpxml', data: Buffer.from('<fcpxml>hello</fcpxml>') },
  { name: 'media/a.txt', data: Buffer.from('重复重复重复'.repeat(50)) },
];
const got0 = readZip(createZip(entries, AT));
assert.equal(got0['project.fcpxml'].raw.toString('utf8'), '<fcpxml>hello</fcpxml>');
assert.equal(got0['media/a.txt'].raw.toString('utf8'), '重复重复重复'.repeat(50));
console.log('✓ zip 写入/回读通过');

(async () => {
  /* ---------- 流式版：file 条目从盘上流式打包，产物与内存版逐字节一致 ---------- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-file-'));
  try {
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0x5a);
    for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;      // 稍微可压 → 走 deflate
    const rnd = require('crypto').randomBytes(1024 * 1024);            // 不可压 → 回退 store
    const xmlData = '<fcpxml>' + 'x'.repeat(200) + '</fcpxml>';
    const srtData = '1\n00:00:00,000 --> 00:00:01,000\n你好\n'.repeat(20);
    fs.writeFileSync(path.join(tmp, 'media.bin'), big);
    fs.writeFileSync(path.join(tmp, 'rnd.bin'), rnd);

    const want = createZip([
      { name: 'project.fcpxml', data: Buffer.from(xmlData) },
      { name: 'media/big.bin', data: big },
      { name: 'subtitles.srt', data: Buffer.from(srtData) },
      { name: 'media/rnd.bin', data: rnd },
    ], AT);
    const streamPath = path.join(tmp, 'out.zip');
    const made = await createZipToFile([
      { name: 'project.fcpxml', data: Buffer.from(xmlData) },
      { name: 'media/big.bin', file: path.join(tmp, 'media.bin') },
      { name: 'subtitles.srt', data: Buffer.from(srtData) },
      { name: 'media/rnd.bin', file: path.join(tmp, 'rnd.bin') },
    ], streamPath, AT);
    const buf = fs.readFileSync(streamPath);
    assert.equal(made.size, buf.length, '回执的字节数与盘上那一份一致');
    /* 两条路同一张头、同一条「压完更短才用 deflate」的规矩：整包逐字节一致。 */
    assert.ok(buf.equals(want), '流式版与内存版逐字节一致（deflate + store 两条路都在）');
    const back = readZip(buf);
    assert.equal(back['project.fcpxml'].raw.toString('utf8'), xmlData);
    assert.ok(back['media/big.bin'].raw.equals(big));
    assert.equal(back['subtitles.srt'].raw.toString('utf8'), srtData);
    assert.ok(back['media/rnd.bin'].raw.equals(rnd));
    assert.equal(back['media/big.bin'].method, 8, '可压的那一条走 deflate');
    assert.equal(back['media/rnd.bin'].method, 0, '不可压的那一条回退 store');
    /* 旁挂临时文件收尾清干净 */
    assert.deepEqual(fs.readdirSync(tmp).filter(n => n.includes('.ziptmp-')), [], '旁挂临时文件没有留下');
    console.log('✓ zip 流式打包通过（file 条目 + 字节对照 + store 回退 + 临时文件清理）');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => {
  console.error('✗ ' + ((e && e.stack) || e));
  process.exit(1);
});
