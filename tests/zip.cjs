#!/usr/bin/env node
'use strict';
const assert = require('assert');
const zlib = require('zlib');
const { createZip, crc32 } = require('../server/zip.js');

const entries = [
  { name: 'project.fcpxml', data: Buffer.from('<fcpxml>hello</fcpxml>') },
  { name: 'media/a.txt', data: Buffer.from('重复重复重复'.repeat(50)) },
];
const zip = createZip(entries, new Date('2026-10-18T00:00:00Z'));
const eocd = zip.length - 22;
assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
const count = zip.readUInt16LE(eocd + 10);
assert.equal(count, 2);
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
  got[name] = raw.toString('utf8');
  p += 46 + nlen + elen + clen;
}
assert.equal(got['project.fcpxml'], '<fcpxml>hello</fcpxml>');
assert.equal(got['media/a.txt'], '重复重复重复'.repeat(50));
console.log('✓ zip 写入/回读通过');
