/* 最小 ZIP 写入器（无第三方依赖）：store / deflate，UTF-8 文件名，不支持 ZIP64。
   仅用于本机 FCPXML 媒体包（文件小、数量有限），不接收上传 zip。
   两只入口同一张头格式、同一条「压完更短才用 deflate」的规矩：
     · createZip —— 全部条目在内存里的 Buffer：整包一次拼完，给小包与判据对照用；
     · createZipToFile —— 盘上文件流式打包：每条先压到同目录旁挂临时文件量准
       （crc / 压缩前后长度），再按同一张头写进包里。内存峰值只有管道的几块 chunk，
       一条 500MB 的素材不再整份进堆；deflate 在 libuv 线程池跑，主线程只做文件读写。 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');

let crcTable = null;
function ensureTable() {
  if (crcTable) return;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
}
function crc32(buf) {
  ensureTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/* 增量口径的 crc32（流式读大文件时一块一块喂）：与 crc32(整份) 逐字一致。 */
const crc32Init = () => { ensureTable(); return 0xffffffff; };
const crc32Feed = (c, chunk) => {
  for (let i = 0; i < chunk.length; i++) c = crcTable[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return c;
};
const crc32Final = c => (c ^ 0xffffffff) >>> 0;

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function createZip(entries, at = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(at);
  for (const e of entries) {
    const name = Buffer.from(String(e.name || 'file').replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data == null ? '' : e.data);
    const crc = crc32(raw);
    let method = 0, data = raw;
    try {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) { method = 8; data = deflated; }
    } catch (err) {}
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, name, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(local);
    centrals.push(Buffer.concat([ch, name]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, eocd]);
}

/* 盘上那一份 → deflate 流 → 旁挂临时文件；crc 按块喂（与 crc32(整份) 一致）。
   resolve 出来的是原始字节的 crc；压缩后长度由调用方 stat 旁挂文件得到。 */
function deflateFileTo(src, dst) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const def = zlib.createDeflateRaw({ level: 6 });
    const ws = fs.createWriteStream(dst, { flags: 'w' });
    let c = crc32Init();
    rs.on('data', chunk => { c = crc32Feed(c, chunk); });
    const failAll = e => {
      try { rs.destroy(); } catch {}
      try { def.destroy(); } catch {}
      try { ws.destroy(); } catch {}
      reject(e);
    };
    rs.on('error', failAll);
    def.on('error', failAll);
    ws.on('error', failAll);
    ws.on('finish', () => resolve(crc32Final(c)));
    rs.pipe(def).pipe(ws);
  });
}

/* 流式版：entries 里 `{ name, data }`（内存小条目）与 `{ name, file }`（盘上文件）可混用。
   每一条都是「先量准再入包」——本地头写下去时 crc 与两个长度都是真值，
   与 createZip 产出的字节布局完全一致。返回 { size }（整包字节数）。
   outPath 所在目录必须已存在（调用方 writeBundle 刚建好它）；旁挂临时文件在收尾时清掉，
   失败路径只留 `*.ziptmp-*`，由调用方的失败清理（rmSync 整目录）一并带走。 */
async function createZipToFile(entries, outPath, at = new Date()) {
  const { time, date } = dosTime(at);
  const out = fs.createWriteStream(outPath, { flags: 'w' });
  const writeChunk = chunk => new Promise((resolve, reject) => {
    out.write(chunk, err => (err ? reject(err) : resolve()));
  });
  const tmps = [];
  try {
    const centrals = [];
    let offset = 0;
    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      const name = Buffer.from(String(e.name || 'file').replace(/\\/g, '/'), 'utf8');
      let method = 0, crc = 0, rawLen = 0, dataLen = 0, src = null;
      if (e.file) {
        rawLen = (await fsp.stat(e.file)).size;
        const tmp = outPath + '.ziptmp-' + process.pid + '-' + idx;
        tmps.push(tmp);
        crc = await deflateFileTo(e.file, tmp);
        const compSize = (await fsp.stat(tmp)).size;
        if (compSize < rawLen) { method = 8; dataLen = compSize; src = tmp; }
        else { method = 0; dataLen = rawLen; src = e.file; }
      } else {
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data == null ? '' : e.data);
        crc = crc32(raw);
        rawLen = raw.length;
        let data = raw;
        try {
          const deflated = zlib.deflateRawSync(raw, { level: 6 });
          if (deflated.length < raw.length) { method = 8; data = deflated; }
        } catch (err) {}
        dataLen = data.length;
        src = data;                     // 小条目就地写，不开读流
      }
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(dataLen, 18);
      lh.writeUInt32LE(rawLen, 22);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(0, 28);
      await writeChunk(lh);
      await writeChunk(name);
      if (Buffer.isBuffer(src)) {
        await writeChunk(src);
      } else {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(src);
          let seen = 0;
          rs.on('error', reject);
          rs.on('data', chunk => { seen += chunk.length; });
          rs.on('end', () => (seen === dataLen ? resolve() : reject(new Error('zip 条目字节数对不上：' + name + ' 期望 ' + dataLen + ' 实写 ' + seen))));
          rs.pipe(out, { end: false });
        });
      }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(time, 12);
      ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(dataLen, 20);
      ch.writeUInt32LE(rawLen, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt16LE(0, 30);
      ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34);
      ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE(0, 38);
      ch.writeUInt32LE(offset, 42);
      centrals.push(Buffer.concat([ch, name]));
      offset += 30 + name.length + dataLen;
    }
    const central = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    await writeChunk(Buffer.concat([central, eocd]));
    out.end();
    await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    return { size: offset + central.length + 22 };
  } catch (e) {
    try { out.destroy(); } catch {}
    throw e;
  } finally {
    for (const t of tmps) { try { await fsp.unlink(t); } catch {} }
  }
}
module.exports = { createZip, createZipToFile, crc32 };
