#!/usr/bin/env node
/* 本机资产「一份本体 + 双身份」的读写全链路判据（隔离实例，AGENTS §13.2）。
   跑法：node tests/e2e/local-chain.cjs
   覆盖的都是「搬错了就再也找不回」的那几件事：
     · 落点：本体在 <库根>\<类型>\<规范名>.<ext>，账在 .data\local-assets\（库根与账分家）；
     · 身份：每条带 fid（<dev>:<ino>，同盘改名/挪目录还认得）与采样签名（<字节数>:<头尾 1MB 的 sha1 前 16 位>，
       换盘、跨卷拷贝、被同步盘重写一遍也还认得内容）；
     · 认回：用户改名 → 三级认回（相对路径 → fid → 签名）并把新路径写回账；
     · 不重复：同一任务重复镜像只一张卡；换了中转地址重下、手工拷进来的同内容两份，都并成一条账（altPaths），
       删一张卡把名下每一份字节一起收掉；
     · 删除按「卡」不按「条」：一条卡背后可能是两条账两份字节（同内容、来源地址不同），
       整组一起收 —— 只收一条就留下「删了又回来」的那一条；
     · 磁盘对账：盘上多出一份没记账的成品会补进账，但**只补一次**；用户手删文件不偷偷裁条目（回源外链与那笔费用还在）。
   ⚠ 三个根全部由 harness 指到 .*-probe-* 目录：这台机器上真正的 下载\拾帧 里是用户成品，探针一个字节都不许碰。 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness.cjs');

const ok = [], bad = [];
const say = (name, pass, note) => (pass ? ok : bad).push(name + (note ? ' — ' + note : ''));

/* 账本 = 快照 index.json + 追加日志 index.jsonl。直接读盘是为了看「代理到底记了什么」，不经过接口。 */
function ledger(dataDir) {
  const IDX = path.join(dataDir, 'local-assets');
  let list = [];
  try { const s = JSON.parse(fs.readFileSync(path.join(IDX, 'index.json'), 'utf8')); list = Array.isArray(s) ? s : (s.items || []); } catch {}
  const byId = new Map(list.map(x => [x.id, x]));
  let lines = [];
  try { lines = fs.readFileSync(path.join(IDX, 'index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.op === 'del') byId.delete(o.id); else if (o.item) byId.set(o.item.id, o.item);
  }
  return [...byId.values()];
}

/* 一张 1x1 PNG；变体**在 IEND 之后追加真实字节**（别在 base64 串尾巴上拼字符：
   `==` 之后的内容会被解码器丢掉，两份字节其实一模一样，于是「新的一份」被判成重复、只删源不搬，测出来的全是假绿）。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = extra => (extra ? Buffer.concat([PNG, Buffer.from(String(extra))]) : PNG);

async function main() {
  /* AUTOSAVE_DIR 把整个「下载」基座指走（server/user-dirs.js 的探针口）：
     不设的话 下载\拾帧 就是默认库根与旧落点，这一条判据就成在动用户成品了。 */
  const dlBase = path.resolve(__dirname, '../..', '.downloads-probe-' + process.pid);
  const proxy = await h.startProxy({ env: { AUTOSAVE_DIR: dlBase } });
  const LIB = proxy.assetsDir, DATA = proxy.dataDir, BASE = proxy.base, cookie = proxy.cookie;
  const req = async (p, opt = {}) => {
    const r = await fetch(BASE + p, Object.assign({}, opt, { headers: Object.assign({ cookie }, opt.headers || {}) }));
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  const bytesOf = async p => {
    const r = await fetch(BASE + p, { headers: { cookie } });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const post = (p, body) => req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const mirror = (name, extra, meta) => post('/local-assets', {
    name, mime: 'image/png', format: 'png', data: png(extra || '').toString('base64'), meta: meta || {},
  });
  try {
    const named = JSON.stringify((proxy.status && proxy.status['目录']) || {});
    say('答话的是探针实例（账与库都点名探针目录）',
      named.includes(path.basename(DATA)) && named.includes(path.basename(LIB)), named.slice(0, 200));

    /* ① 落一份带人类可读名的产物 */
    const a = await mirror('开场镜头-候选1.png', '', { prompt: '第一张' });
    const idA = a.json && a.json.id;
    say('POST /local-assets 回 id', !!idA, JSON.stringify(a.json && { id: a.json.id, url: a.json.url, file: a.json.file }));
    const rowA = ledger(DATA).find(x => x.id === idA);
    say('账在 .<探针>/local-assets', !!rowA, '');
    say('本体落在 图片\\ 且用规范名', rowA && /^图片[\\/]/.test(rowA.file) && /开场镜头-候选1\.png$/.test(rowA.file), rowA && rowA.file);
    say('落在库根之下', rowA && fs.existsSync(path.join(LIB, rowA.file)), rowA && path.join(LIB, rowA.file));
    say('带 fid（同盘改名挪目录靠它）', rowA && !!rowA.fid && /^\d+:\d+$/.test(String(rowA.fid)), rowA && rowA.fid);
    say('带采样签名（<字节数>:<16 位十六进制>）', rowA && /^\d+:[0-9a-f]{16}$/.test(String(rowA.sig)), rowA && rowA.sig);
    const g1 = await bytesOf('/asset/' + idA);
    say('GET /asset/<id> 字节原样读得到', g1.status === 200 && g1.buf.equals(png('')), '状态 ' + g1.status + ' · ' + g1.buf.length + '/' + png('').length + ' 字节');

    /* ② 同名再来一份：不覆盖，加 -2 */
    const a2 = await mirror('开场镜头-候选1.png', 'x', { prompt: '第二张' });
    const rowB = ledger(DATA).find(x => x.id === (a2.json || {}).id);
    say('同名不覆盖，落 -2', rowB && /-2\.png$/.test(rowB.file), rowB && rowB.file);

    /* ③ 用户改名 → fid 命中认回，并把新路径写回账 */
    const before = rowA.file;
    const renamed = path.join(LIB, path.dirname(before), '我自己改的名.png');
    fs.renameSync(path.join(LIB, before), renamed);
    const g2 = await req('/asset/' + idA);
    const rowA2 = ledger(DATA).find(x => x.id === idA);
    say('改名后仍读得到', g2.status === 200, '状态 ' + g2.status);
    say('账跟着改名走', rowA2 && /我自己改的名\.png$/.test(String(rowA2.file)), rowA2 && before + ' → ' + rowA2.file);

    /* ④ 用户挪到别的目录（同卷 → 还是 fid 那一级命中） */
    const elsewhere = path.join(LIB, '其他');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.renameSync(renamed, path.join(elsewhere, '我自己改的名.png'));
    const g3 = await req('/asset/' + idA);
    const rowA3 = ledger(DATA).find(x => x.id === idA);
    say('挪目录后仍读得到', g3.status === 200, '状态 ' + g3.status);
    say('账记成新路径', rowA3 && /^其他[\\/]/.test(String(rowA3.file)), rowA3 && rowA3.file);

    /* ⑤ 同一任务重复下载（同 upstream）：不新开文件、列表一张卡 */
    const up1 = 'https://example.com/same.png?sig=abc';
    const m1 = await mirror('重复下载.png', 'dup', { upstream: up1 });
    const m2 = await mirror('重复下载.png', 'dup', { upstream: up1 });
    say('第二次镜像判成复用', m2.json && m2.json.reused === true && m2.json.id === m1.json.id,
      JSON.stringify(m2.json && { reused: m2.json.reused, id: m2.json.id }));
    const list1 = await req('/local-assets');
    say('列表里同来源只一张卡', (list1.json.data || []).filter(x => String(x.upstream || '').includes('same.png')).length === 1, '');
    /* 换了中转地址重下（来源不同、内容相同）→ 靠内容签名并成一张卡 */
    const m3 = await mirror('重复下载.png', 'dup', { upstream: 'https://other-cdn.example.com/again.png?sig=zzz' });
    const list1b = await req('/local-assets');
    const sameContent = (list1b.json.data || []).filter(x => /重复下载/.test(String(x.name || '')));
    say('换了来源地址重下也只一张卡（按内容签名）', sameContent.length === 1,
      '数到 ' + sameContent.length + ' 张 · 第三次镜像 ' + JSON.stringify(m3.json && { reused: m3.json.reused, id: m3.json.id }));
    say('列表报了压着几份重复', typeof list1b.json.duplicates === 'number' && list1b.json.duplicates >= 1, 'duplicates=' + list1b.json.duplicates);

    /* ⑤b 删一张卡 = 删这一张卡背后的每一条：上面那两条账（号不同、来源地址不同、内容相同）在界面上
          是一张卡，只收眼前那一条的话另一条下一轮又单独成为一张卡（或变成「文件已不在」的空条）。 */
    const dupRows = ledger(DATA).filter(x => /重复下载/.test(String(x.name || '')));
    const dupFiles = dupRows.map(x => path.join(LIB, x.file));
    say('同内容不同来源落了两条账', dupRows.length === 2, JSON.stringify(dupRows.map(x => x.file)));
    const delDup = await req('/local-assets/' + dupRows[0].id, { method: 'DELETE' });
    say('删这一张卡把两条账一起收掉', delDup.status === 200 && delDup.json && delDup.json.rows === 2, JSON.stringify(delDup.json));
    say('两份字节都没了', dupFiles.every(f => !fs.existsSync(f)), JSON.stringify(dupFiles.map(f => fs.existsSync(f))));
    const list1c = await req('/local-assets');
    say('下一轮列表里没有复活的卡', (list1c.json.data || []).filter(x => /重复下载/.test(String(x.name || ''))).length === 0, '');

    /* ⑥ 盘上多出一份没记账的成品 → 磁盘对账补账，且只补一次。
       dirScan 有 30 秒缓存（列表 / 认回 / 用量共用一份），先用「用量」把缓存掐新
       （它就是 dirScan(true)），再走列表 —— 这等价于用户「设置页看一眼用量 → 回资产库」那条真实顺序。 */
    fs.writeFileSync(path.join(LIB, '图片', '手工放进来的一张.jpg'), png('zz'));
    await req('/assets-usage');
    const list2 = await req('/local-assets');
    const adopted = (list2.json.data || []).find(x => /手工放进来的一张\.jpg$/.test(String(x.file || '') + String(x.name || '')));
    say('没记账的文件被对账补进账', !!adopted, adopted ? adopted.file : '列表里没有它');
    const list3 = await req('/local-assets');
    say('补账只补一次（列表不翻倍）', (list3.json.data || []).filter(x => /手工放进来/.test(String(x.name || ''))).length === 1, '');

    /* ⑦ 删一条：连 altPaths 一起删，索引同步收 */
    const del = await req('/local-assets/' + idA, { method: 'DELETE' });
    say('DELETE 回 ok', del.status === 200 && del.json && del.json.ok === true, JSON.stringify(del.json));
    say('盘上那一份真没了', !fs.existsSync(path.join(elsewhere, '我自己改的名.png')), '');
    say('索引里那条收掉', !ledger(DATA).find(x => x.id === idA), '');

    /* ⑧ 用户自己拷进来的两份同内容文件（不同目录）→ 并成一条账、一张卡，删的时候两份一起收 */
    fs.writeFileSync(path.join(LIB, '图片', '拷来的一份.png'), png('twin'));
    fs.writeFileSync(path.join(elsewhere, '拷来的另一份.png'), png('twin'));
    await req('/assets-usage');
    await req('/local-assets');
    const twinRows = ledger(DATA).filter(x => /拷来的(一份|另一份)\.png$/.test(String(x.file || '')));
    const twinRow = twinRows[0];
    say('同内容两份并成一条账', twinRows.length === 1, '账上 ' + twinRows.length + ' 条');
    say('另一份挂成 altPaths', twinRow && Array.isArray(twinRow.altPaths) && twinRow.altPaths.length === 1, twinRow && JSON.stringify(twinRow.altPaths));
    const list4 = await req('/local-assets');
    const twinCards = (list4.json.data || []).filter(x => /拷来的/.test(String(x.name || '')));
    say('资产库只一张卡', twinCards.length === 1, '数到 ' + twinCards.length + ' 张');
    const gTwin = await bytesOf('/asset/' + (twinRow && twinRow.id));
    say('这张卡按号读得到内容', gTwin.status === 200 && gTwin.buf.equals(png('twin')), '状态 ' + gTwin.status);
    const delTwin = await req('/local-assets/' + twinRow.id, { method: 'DELETE' });
    say('删一张卡把两份字节都收掉', delTwin.status === 200 && delTwin.json && delTwin.json.files === 2, JSON.stringify(delTwin.json));
    say('盘上两份都没了', !fs.existsSync(path.join(LIB, '图片', '拷来的一份.png')) && !fs.existsSync(path.join(elsewhere, '拷来的另一份.png')), '');

    /* ⑨ 盘上那一份被用户在文件管理器里删了：账不偷偷裁（回源外链与那笔费用还在），列表仍看得见这一条 */
    const lost = ledger(DATA).find(x => /手工放进来的一张\.jpg$/.test(String(x.file || '')));
    say('对账补建的那条在账上', !!lost, lost && lost.id);
    fs.unlinkSync(path.join(LIB, lost.file));
    await req('/assets-usage');
    const list5 = await req('/local-assets');
    const lostCard = (list5.json.data || []).find(x => x.id === lost.id);
    say('文件没了但条目没被偷偷裁掉', !!lostCard, '列表里找不到它了');
    const delLost = await req('/local-assets/' + lost.id, { method: 'DELETE' });
    say('删一条「文件已不在」的能删干净（files 0）', delLost.status === 200 && delLost.json && delLost.json.files === 0, JSON.stringify(delLost.json));
    say('账里也收掉了', !ledger(DATA).find(x => x.id === lost.id), '');

    /* ⑩ 采样签名为什么是「头 + 尾」而不是整份：一条几百 MB 的片子每轮对账都全量读一遍，
       盘吃不消；但中段不同的两份字节必须判成两份（否则删一张卡会带走另一张的本体）。 */
    const head = png('same-head');
    const bigA = Buffer.concat([head, Buffer.alloc(2 * 1024 * 1024, 1), head]);
    const bigB = Buffer.concat([head, Buffer.alloc(2 * 1024 * 1024, 2), head]);
    const b1 = await post('/local-assets', { name: '中段不同的一份.mp4', mime: 'video/mp4', format: 'mp4', data: bigA.toString('base64'), meta: {} });
    const b2 = await post('/local-assets', { name: '中段不同的另一份.mp4', mime: 'video/mp4', format: 'mp4', data: bigB.toString('base64'), meta: {} });
    const r1 = ledger(DATA).find(x => x.id === b1.json.id), r2 = ledger(DATA).find(x => x.id === b2.json.id);
    say('中段不同的两份字节不被并成一张卡', !!r1 && !!r2 && r1.id !== r2.id && r1.sig !== r2.sig,
      JSON.stringify([r1 && r1.sig, r2 && r2.sig]));
    say('它们各自落在 视频\\', r1 && r2 && /^视频[\\/]/.test(r1.file) && /^视频[\\/]/.test(r2.file), JSON.stringify([r1 && r1.file, r2 && r2.file]));
  } catch (e) {
    say('判据跑通', false, ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e));
  } finally {
    await proxy.stop();
    try { fs.rmSync(dlBase, { recursive: true, force: true }); } catch {}
    console.log('本机资产读写链路：✓ 通过 ' + ok.length + ' 项');
    ok.forEach(x => console.log('   · ' + x));
    if (bad.length) { console.log('✗ 未通过 ' + bad.length + ' 项'); bad.forEach(x => console.log('   ! ' + x)); }
  }
  if (bad.length) process.exit(1);
}

main().catch(e => { console.log('判据自己炸了：' + ((e && e.stack) || e)); process.exit(1); });
