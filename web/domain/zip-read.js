/* 浏览器端只读 zip：Skill 导入只认 .md/.txt/.json 文本，脚本与二进制一律不收。
   - 不执行任何压缩包内容，不解到磁盘；只在内存里取 central directory 再解压需要的条目。
   - 路径穿越、绝对路径、盘符、>50 文件、解压后 >5MB、单文件 >1MB / >1000 行都在这里拒。
   - 只支持 store(0) / deflate(8)；ZIP64 与加密条目不支持，直接报错而不是猜。 */
(function () {
  'use strict';
  var MAX_FILES = 50;
  var MAX_TOTAL = 5 * 1024 * 1024;
  var MAX_ONE = 1024 * 1024;
  var MAX_LINES = 1000;
  var ALLOWED = /\.(md|txt|json)$/i;
  var SIG_EOCD = 0x06054b50;
  var SIG_CEN = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;

  function u16(dv, off) { return dv.getUint16(off, true); }
  function u32(dv, off) { return dv.getUint32(off, true); }

  function eocdOf(dv, bytes) {
    var min = Math.max(0, bytes - 22 - 65535);
    for (var off = bytes - 22; off >= min; off--) {
      if (u32(dv, off) === SIG_EOCD) return off;
    }
    return -1;
  }

  function decoderFor(flags) {
    if (flags & 0x0800) return new TextDecoder('utf-8');
    try { return new TextDecoder('utf-8', { fatal: true }); }
    catch (e) { return new TextDecoder('utf-8'); }
  }

  function cleanPath(name) {
    var p = String(name || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!p || p.charAt(p.length - 1) === '/') return '';
    if (p.charAt(0) === '/' || /^[a-z]:/i.test(p) || p.indexOf('\u0000') >= 0) {
      throw new Error('压缩包里有非法路径：' + p);
    }
    var parts = p.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.' || parts[i] === '..') throw new Error('压缩包里有路径穿越：' + p);
    }
    if (!ALLOWED.test(p)) throw new Error('只接受 .md / .txt / .json：' + p);
    return p;
  }

  async function inflate(slice) {
    if (typeof DecompressionStream !== 'function') throw new Error('这个浏览器不支持解压 zip（没有 DecompressionStream）');
    var stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer();
  }

  function textOf(buf, flags) {
    var view = new Uint8Array(buf);
    for (var i = 0; i < view.length; i++) if (view[i] === 0) throw new Error('文件里有二进制内容');
    var dec = decoderFor(flags);
    var text;
    try { text = dec.decode(view); }
    catch (e) { throw new Error('文件不是 UTF-8 文本'); }
    if (text.split(/\r?\n/).length > MAX_LINES) throw new Error('文件超过 ' + MAX_LINES + ' 行');
    return text;
  }

  async function read(file) {
    if (!file) throw new Error('没有选文件');
    var ab = await file.arrayBuffer();
    var bytes = ab.byteLength;
    if (bytes < 22) throw new Error('不是有效的 zip');
    var dv = new DataView(ab);
    var eocd = eocdOf(dv, bytes);
    if (eocd < 0) throw new Error('不是有效的 zip（找不到目录尾）');
    var total = u16(dv, eocd + 10);
    var cdSize = u32(dv, eocd + 12);
    var cdOff = u32(dv, eocd + 16);
    if (total === 0xffff || cdOff === 0xffffffff) throw new Error('不支持 ZIP64');
    if (!total) throw new Error('压缩包里没有文件');
    if (total > MAX_FILES) throw new Error('文件超过 ' + MAX_FILES + ' 个');
    if (cdOff + cdSize > bytes) throw new Error('zip 目录越界（文件可能损坏）');
    var out = [];
    var sum = 0;
    var off = cdOff;
    for (var i = 0; i < total; i++) {
      if (off + 46 > bytes || u32(dv, off) !== SIG_CEN) throw new Error('zip 目录损坏');
      var flags = u16(dv, off + 8);
      var method = u16(dv, off + 10);
      if (flags & 0x0001) throw new Error('不支持加密的 zip');
      var compSize = u32(dv, off + 20);
      var rawSize = u32(dv, off + 24);
      var nameLen = u16(dv, off + 28);
      var extraLen = u16(dv, off + 30);
      var commentLen = u16(dv, off + 32);
      var localOff = u32(dv, off + 42);
      var nameBytes = new Uint8Array(ab, off + 46, nameLen);
      var name = decoderFor(flags).decode(nameBytes);
      off += 46 + nameLen + extraLen + commentLen;
      var rel = cleanPath(name);
      if (!rel) continue;
      if (rawSize > MAX_ONE) throw new Error('单文件超过 1MB：' + rel);
      sum += rawSize;
      if (sum > MAX_TOTAL) throw new Error('解压后超过 5MB');
      if (localOff + 30 > bytes || u32(dv, localOff) !== SIG_LOCAL) throw new Error('zip 条目损坏：' + rel);
      var lnLen = u16(dv, localOff + 26);
      var leLen = u16(dv, localOff + 28);
      var dataOff = localOff + 30 + lnLen + leLen;
      if (dataOff + compSize > bytes) throw new Error('zip 条目越界：' + rel);
      var slice = ab.slice(dataOff, dataOff + compSize);
      var raw;
      if (method === 0) raw = slice;
      else if (method === 8) raw = await inflate(slice);
      else throw new Error('不支持的压缩方式（' + method + '）：' + rel);
      if (raw.byteLength > MAX_ONE) throw new Error('单文件超过 1MB：' + rel);
      out.push({ path: rel, text: textOf(raw, flags), size: rawSize });
    }
    if (!out.length) throw new Error('压缩包里没有可导入的文本文件');
    return { files: out, bytes: sum };
  }

  window.ZipRead = { read: read };
})();
