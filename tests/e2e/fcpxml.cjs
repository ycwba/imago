#!/usr/bin/env node
/* FCPXML 媒体包与「送到剪映 / 达芬奇」：
   ① POST /fcpxml/bundle 必须回 zip，含 project.fcpxml；缺素材写 missing.txt；
      带字幕时按固定名字写 subtitles.srt（包内与盘上都要在、字节要一模一样），
      体量 / 条数超上限当场拒并一个目录都不建（服务端那一行）。
   ② 素材重名在建目录之前 400（静默改名会让 XML 与盘上文件对不上）。
   ③ POST /fcpxml/import 留持久目录：project.fcpxml + media/ + subtitles.srt + missing.txt + bundle.zip。
   ④ /fcpxml/reveal 只认导入目录里的 id；/fcpxml/launch 只认两家枚举，非法值 400。
   ⑤ 清扫只认自己那种目录名：bundle 目录与导入目录各留最近 20 个；fcpxml-import 顶层与
      用户在 .renders 里自己放的文件夹不动。
   探针实例带 WB_FCPXML_DRY=1：reveal / launch 不真的拉起用户的软件。 */
'use strict';
const fs = require('fs');
const path = require('path');
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
    proxy = await h.startProxy({ env: { WB_FCPXML_DRY: '1' } });
    const post = (p, body) => fetch(proxy.base + p, {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await post('/fcpxml/bundle', {
      fcpxml: '<fcpxml><project/></fcpxml>',
      assets: [{ src: 'https://127.0.0.1/nope.mp4', name: 'missing.mp4' }],
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
    const r2 = await post('/fcpxml/bundle', {
      fcpxml: '<fcpxml><project/></fcpxml>',
      assets: [{ src: '/asset/' + la.id, name: 'tone.wav' }],
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
    const r3 = await post('/fcpxml/bundle', { fcpxml: '<fcpxml><project/></fcpxml>', srt: srt, assets: [] });
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
      const rr = await post('/fcpxml/bundle', body);
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

    /* ---------- 一键导入：持久目录 + 中文场景镜头名 ---------- */
    const importRoot = path.join(proxy.renderDir, 'fcpxml-import');
    const importIds = () => {
      try { return fs.readdirSync(importRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
      catch (e) { return []; }
    };
    const chineseWav = Buffer.alloc(2048);
    chineseWav.write('RIFF', 0); chineseWav.write('WAVE', 8);
    const cn = await fetch(proxy.base + '/local-assets', {
      method: 'POST',
      headers: { cookie: proxy.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '场景01-雨夜街头_镜头03-推门_候选2.wav',
        data: chineseWav.toString('base64'), format: 'wav', mime: 'audio/wav', meta: {} }),
    }).then(r => r.json());
    if (!cn || !cn.id) throw new Error('造中文名本机资产失败：' + JSON.stringify(cn));
    const cnName = '场景01-雨夜街头_镜头03-推门_候选2.wav';
    const missName = '场景02-清晨_镜头01-回头_配音1.wav';
    const impBody = {
      fcpxml: '<fcpxml><project name="中文名测试"/></fcpxml>',
      srt,
      assets: [
        { src: '/asset/' + cn.id, name: cnName },
        { src: 'https://127.0.0.1/nope.wav', name: missName },
      ],
    };
    const ir = await post('/fcpxml/import', impBody);
    const imp = await ir.json();
    if (ir.status !== 200 || !imp.ok || !imp.id) throw new Error('导入工程失败：HTTP ' + ir.status + ' ' + JSON.stringify(imp));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(imp.id)) throw new Error('导入 id 形状不对：' + imp.id);
    if (path.resolve(imp.dir) !== path.resolve(importRoot, imp.id)) throw new Error('导入目录与 id 不同源：' + imp.dir);
    for (const f of ['project.fcpxml', 'media/' + cnName, 'subtitles.srt', 'missing.txt', 'bundle.zip']) {
      if (!fs.existsSync(path.join(imp.dir, f))) throw new Error('导入目录缺 ' + f);
    }
    if (fs.readFileSync(path.join(imp.dir, 'project.fcpxml'), 'utf8') !== impBody.fcpxml) throw new Error('project.fcpxml 内容被改了');
    if (fs.readFileSync(path.join(imp.dir, 'media', cnName)).length !== chineseWav.length) throw new Error('中文名素材字节不对');
    if (fs.readFileSync(path.join(imp.dir, 'subtitles.srt'), 'utf8') !== srt) throw new Error('导入目录的字幕字节不对');
    const missingTxt = fs.readFileSync(path.join(imp.dir, 'missing.txt'), 'utf8');
    if (missingTxt.indexOf(missName) < 0) throw new Error('missing.txt 没点名缺失素材：' + missingTxt.slice(0, 200));
    if (imp.missingCount !== 1) throw new Error('missingCount 应为 1，实际 ' + imp.missingCount);
    if (imp.assets !== 1) throw new Error('进入包里的素材应为 1，实际 ' + imp.assets);

    /* 重名：建目录之前就要 400，盘上不许留下半截目录。 */
    const beforeDup = importIds().length;
    const dupBody = { fcpxml: '<fcpxml><project/></fcpxml>', assets: [
      { src: '/asset/' + cn.id, name: 'a/b.wav' },
      { src: '/asset/' + cn.id, name: 'a:b.wav' },
    ] };
    const dr = await post('/fcpxml/import', dupBody);
    const dtxt = await dr.text();
    if (dr.status !== 400) throw new Error('重名应 400，实际 ' + dr.status + '：' + dtxt.slice(0, 200));
    if (dtxt.indexOf('素材名重复') < 0 || dtxt.indexOf('a-b.wav') < 0) throw new Error('重名要说清撞了哪个名字：' + dtxt.slice(0, 200));
    if (importIds().length !== beforeDup) throw new Error('重名被拒之后却留下了导入目录');

    /* ---------- reveal / launch：只认合法 id 与两家枚举（dry-run，不拉起真软件） ---------- */
    const rv = await post('/fcpxml/reveal', { id: imp.id });
    const rj = await rv.json();
    if (rv.status !== 200 || !rj.ok || path.resolve(rj.dir) !== path.resolve(imp.dir)) {
      throw new Error('reveal 合法 id 失败：HTTP ' + rv.status + ' ' + JSON.stringify(rj));
    }
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65)]) {
      const br = await post('/fcpxml/reveal', { id: bad });
      if (br.status !== 400) throw new Error('reveal 非法 id 应 400（' + bad + '），实际 ' + br.status);
    }
    const nr = await post('/fcpxml/reveal', { id: 'missing-id-123' });
    if (nr.status !== 404) throw new Error('reveal 不存在的目录应 404，实际 ' + nr.status);
    const lr = await post('/fcpxml/launch', { app: 'premiere' });
    if (lr.status !== 400) throw new Error('launch 非法 app 应 400，实际 ' + lr.status);
    for (const app of ['jianying', 'resolve']) {
      const rr = await post('/fcpxml/launch', { app });
      const j = await rr.json();
      if (rr.status !== 200 || typeof j.ok !== 'boolean') throw new Error('launch ' + app + ' 返回形状不对：' + JSON.stringify(j));
      if (!j.ok && !j.reason) throw new Error('launch 没启动时要说清原因：' + JSON.stringify(j));
    }

    /* ---------- 清扫：只扫自己那种目录名，各留最近 20 个 ---------- */
    const userDir = path.join(proxy.renderDir, '我的样片');              // 用户自己放进 .renders 的文件夹
    const importUser = path.join(importRoot, '我的工程');                 // 导入目录里用户自己放的（id 形状不合法）
    const keepImport = path.join(importRoot, '20000101-000000-keepme');   // 合法的老导入目录，按名字排得进前 20
    for (const d of [userDir, importUser, keepImport]) fs.mkdirSync(d, { recursive: true });
    /* 各造 25 个比现存都老的目录：名字就是排序依据（bundle 带 fcpxml- 前缀，导入目录是纯时间戳） */
    for (let i = 0; i < 25; i++) {
      const n = '19990101-000000-' + String(i).padStart(2, '0');
      fs.mkdirSync(path.join(proxy.renderDir, 'fcpxml-' + n), { recursive: true });
      fs.mkdirSync(path.join(importRoot, n), { recursive: true });
    }
    /* 清扫挂在这两条路由收尾，各打一次就够 */
    const cleanBundle = await post('/fcpxml/bundle', { fcpxml: '<fcpxml><project/></fcpxml>', assets: [] });
    if (cleanBundle.status !== 200) {
      throw new Error('清扫用的 bundle 失败：HTTP ' + cleanBundle.status + '：' + (await cleanBundle.text()).slice(0, 160));
    }
    const cleanImport = await post('/fcpxml/import', { fcpxml: '<fcpxml><project/></fcpxml>', assets: [] });
    const ci = await cleanImport.json();
    if (cleanImport.status !== 200 || !ci.ok) throw new Error('清扫用的导入失败：HTTP ' + cleanImport.status + ' ' + JSON.stringify(ci));

    if (bundles().length > 20) throw new Error('bundle 目录超过 20 个没被清：' + bundles().length);
    if (!fs.existsSync(path.join(proxy.renderDir, 'fcpxml-import'))) throw new Error('bundle 清扫把 fcpxml-import 顶层目录删了');
    if (fs.existsSync(path.join(proxy.renderDir, 'fcpxml-19990101-000000-00'))) throw new Error('最老的 bundle 目录没被清掉');
    if (!fs.existsSync(userDir)) throw new Error('清扫把用户在 .renders 里自己的文件夹当垃圾删了');

    const idNow = importIds().filter(n => /^[A-Za-z0-9_-]{1,64}$/.test(n));
    if (idNow.length > 20) throw new Error('导入目录超过 20 个没被清：' + idNow.length);
    if (idNow.includes('19990101-000000-00')) throw new Error('最老的导入目录没被清掉');
    if (!fs.existsSync(keepImport)) throw new Error('导入清扫把排得进前 20 的老工程也删了');
    if (!fs.existsSync(importUser)) throw new Error('导入清扫把用户自己放的文件夹删了');
    if (!fs.existsSync(ci.dir)) throw new Error('导入清扫把刚建好的工程目录删了');

    console.log('✓ FCPXML 媒体包通过（' + ns.join(' / ') + '；本机素材已打包；字幕按固定名 subtitles.srt 落包与落盘；' +
      '超 5MB / 超 5000 条当场拒，被拒那份一个字都没落盘）；' +
      '一键导入目录（中文场景镜头名 + missing.txt + bundle.zip）、重名 400、reveal/launch 校验与剪映/达芬奇工程保留均通过；'
      + '清扫只认自己那种目录名（bundle 与导入目录各留 20 个），用户自己放的文件夹不动');
  } catch (e) {
    const f = proxy ? h.logFaults(proxy.log) : [];
    console.error('✗ ' + (e && e.stack || e) + (f.length ? '\n代理日志异常：\n  ' + f.join('\n  ') : ''));
    process.exitCode = 1;
  } finally { if (proxy) await proxy.stop(); }
})();
