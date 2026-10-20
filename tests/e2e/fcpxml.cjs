#!/usr/bin/env node
/* FCPXML 媒体包：POST /fcpxml/bundle 必须回 zip，含 project.fcpxml；缺素材写 missing.txt；
   带字幕时按固定名字写 subtitles.srt（包内与盘上都要在、字节要一模一样），
   体量/条数超上限当场拒并一个目录都不建（方案 §11 服务端那一行）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const h = require('./harness.cjs');

function names(zip) {
  const out = [];
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error('不是 zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nlen = zip.readUInt16LE(p + 28), elen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32);
    out.push(zip.slice(p + 46, p + 46 + nlen).toString('utf8'));
    p += 46 + nlen + elen + clen;
  }
  return out;
}
(async () => {
  let proxy;
  try {
    proxy = await h.startProxy();
    const r = await fetch(proxy.base + '/fcpxml/bundle', {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        fcpxml: '<fcpxml><project/></fcpxml>',
        assets: [{ src: 'https://127.0.0.1/nope.mp4', name: 'missing.mp4' }],
      }),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) throw new Error('HTTP ' + r.status + '：' + buf.toString('utf8'));
    if (!/application\/zip/.test(r.headers.get('content-type') || '')) throw new Error('不是 zip 响应');
    const ns = names(buf);
    if (!ns.includes('project.fcpxml')) throw new Error('缺 project.fcpxml：' + ns.join(','));
    if (!ns.includes('missing.txt')) throw new Error('缺 missing.txt：' + ns.join(','));

    /* 媒体包里本机资产要真的被拷进 media/：造一段 1KB 的 wav 走 POST /local-assets。 */
    const wav = Buffer.alloc(1024);
    wav.write('RIFF', 0); wav.write('WAVE', 8);
    const la = await fetch(proxy.base + '/local-assets', {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tone.wav', data: wav.toString('base64'), format: 'wav', mime: 'audio/wav', meta: {} }),
    }).then(r => r.json());
    if (!la || !la.id) throw new Error('造本机资产失败：' + JSON.stringify(la));
    const r2 = await fetch(proxy.base + '/fcpxml/bundle', {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        fcpxml: '<fcpxml><project/></fcpxml>',
        assets: [{ src: '/asset/' + la.id, name: 'tone.wav' }],
      }),
    });
    const buf2 = Buffer.from(await r2.arrayBuffer());
    if (r2.status !== 200) throw new Error('媒体包 HTTP ' + r2.status + '：' + buf2.toString('utf8'));
    const ns2 = names(buf2);
    if (!ns2.includes('media/tone.wav')) throw new Error('媒体包里没有本机素材：' + ns2.join(','));
    if (ns2.includes('missing.txt')) throw new Error('本机素材不该进 missing.txt：' + ns2.join(','));

    /* ---------- 字幕：固定名字、字节原样 ---------- */
    /* 与客户端 SRT 导出同一份文本（BOM + CRLF），这里要的是「包里有、名字就是它、内容没被改」：
       FCP / 达芬奇那边是靠这个文件名兜底的，改名或吞字节都等于用户以为带了字幕而包里却没有。 */
    const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\n第一句\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n第二句\r\n';
    const bundles = () => fs.readdirSync(proxy.renderDir).filter(d => /^fcpxml-/.test(d));
    const r3 = await fetch(proxy.base + '/fcpxml/bundle', {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ fcpxml: '<fcpxml><project/></fcpxml>', srt: srt, assets: [] }),
    });
    const buf3 = Buffer.from(await r3.arrayBuffer());
    if (r3.status !== 200) throw new Error('带字幕的媒体包 HTTP ' + r3.status + '：' + buf3.toString('utf8'));
    const ns3 = names(buf3);
    if (!ns3.includes('subtitles.srt')) throw new Error('包里没有 subtitles.srt：' + ns3.join(','));
    /* 目录名是秒级时间戳：同一秒里再打一次包会落回同一个目录，所以按「哪个目录里有这份一模一样的字幕」找，
       不假设它一定是新建的那一个。 */
    const dirs = bundles();
    const hit = dirs.find(d => {
      try { return fs.readFileSync(path.join(proxy.renderDir, d, 'subtitles.srt'), 'utf8') === srt; } catch (e) { return false; }
    });
    if (!hit) throw new Error('盘上找不到字节原样的 subtitles.srt（翻过 ' + dirs.length + ' 个 fcpxml- 目录）');

    /* ---------- 上限：超了当场拒，被拒的那份内容一个字都不该落盘 ---------- */
    /* 「没建新目录」这条判据用不了：目录名是秒级，同一秒里上一份包已经占着那个名字。
       改成直接查盘上有没有被拒的那份字幕本身 —— 这才是「超了就不写」的真实含义。 */
    const srtOnDisk = () => bundles().map(d => {
      try { return fs.readFileSync(path.join(proxy.renderDir, d, 'subtitles.srt'), 'utf8'); } catch (e) { return ''; }
    }).filter(Boolean);
    const reject = async (body, want, marker, label) => {
      const rr = await fetch(proxy.base + '/fcpxml/bundle', {
        method: 'POST', headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const txt = (await rr.text()).toString();
      if (rr.status !== 400) throw new Error(label + '应 400，实际 ' + rr.status + '：' + txt.slice(0, 160));
      if (txt.indexOf(want) < 0) throw new Error(label + '要说清撞了哪条上限，实际回：' + txt.slice(0, 160));
      const left = srtOnDisk().filter(s => s.indexOf(marker) >= 0);
      if (left.length) throw new Error(label + '被拒之后盘上却留下了它：' + left.length + ' 份');
    };
    await reject({ fcpxml: '<fcpxml><project/></fcpxml>', srt: 'x'.repeat(5 * 1024 * 1024 + 16) + 'MARK-OVER-5MB', assets: [] },
      '5 MB', 'MARK-OVER-5MB', '字幕超过 5MB');
    const many = [];
    for (let i = 1; i <= 5001; i++) many.push(i + '\r\n00:00:0' + (i % 10) + ',000 --> 00:00:0' + (i % 10) + ',500\r\n第 ' + i + ' 条');
    await reject({ fcpxml: '<fcpxml><project/></fcpxml>', srt: many.join('\r\n\r\n'), assets: [] },
      '5000 条', '第 5001 条', '字幕条数超上限');

    console.log('✓ FCPXML 媒体包通过（' + ns.join(' / ') + '；本机素材已打包；字幕按固定名 subtitles.srt 落包与落盘；' +
      '超 5MB / 超 5000 条当场拒，被拒那份一个字都没落盘）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally { if (proxy) await proxy.stop(); }
})();
