#!/usr/bin/env node
/* data-hub 判据：落盘只有两份文件（state.json / backup.json），且
     · 老的一堆 <key>.json / .bak.json / .cloud-*.json 一次性转成 state.json，回读校验通过才删
     · state.json 校验和不通过就拒绝写入，健康状态要把「哪一份坏了」说出来
     · /data/<key> 是逻辑视图：普通字符串原样保存，内部键不进清单
     · 快照轮转 5 份、同内容去重、校验和坏了拒绝恢复、恢复前强制留一份
     · 整包导出/导入带校验和：对不上零写入
   全部在 os.tmpdir 的探针目录里跑，不碰真实 .data / .skills / 库根。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDataHub, CLOUD_STATE_KEY, CLOUD_BASE_KEY, MAX_SNAPSHOTS } = require('../server/data-hub.js');

let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('  ✗ ' + msg); } };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-data-hub-'));
/* 环境变量会改落点与归档目录：探针里一律按默认走，跑完还原。 */
const savedEnv = { DATA_DIR: process.env.DATA_DIR, SKILLS_DIR: process.env.SKILLS_DIR, PROMPTS_DIR: process.env.PROMPTS_DIR };
delete process.env.DATA_DIR;
delete process.env.SKILLS_DIR;
delete process.env.PROMPTS_DIR;

const mkDir = tag => {
  const d = path.join(tmpRoot, tag);
  fs.mkdirSync(path.join(d, '.data'), { recursive: true });
  return d;
};
function hubOf(dir) {
  const applied = { text: null };
  const logs = [];
  const hub = createDataHub({
    root: dir,
    log: s => logs.push(String(s)),
    readBody: async req => Buffer.from(req && req.probeBody != null ? req.probeBody : ''),
    safeDecode: s => { try { return decodeURIComponent(String(s)); } catch { return String(s); } },
    anyRequest: () => { throw new Error('探针里不该发网络请求'); },
    guardOutboundUrl: async u => u,
    localRoot: () => path.join(dir, '库根'),
    fileSafe: s => String(s || '').replace(/[^\w.\-]/g, '_'),
    dirStamp: () => 'probe', timeText: () => '00:00',
    localAssetEntry: () => null,
    applyAssetsIndex: t => { applied.text = t; },
  });
  return { hub, applied, logs, dataDir: path.join(dir, '.data') };
}
function mkRes() {
  const r = {
    statusCode: 0, headers: {}, body: '', headersSent: false, writableEnded: false, destroyed: false,
    writeHead(c, h) { r.statusCode = c; Object.assign(r.headers, h || {}); r.headersSent = true; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; }, getHeader(k) { return r.headers[k]; },
    write(c) { if (c) r.body += String(c); return true; },
    end(c) { if (c != null) r.body += String(c); r.writableEnded = true; return r; },
    destroy() { r.destroyed = true; },
  };
  return r;
}
async function call(handler, req) {
  const res = mkRes();
  handler(req, res, new URL(req.url, 'http://127.0.0.1'));
  /* POST 那几条走 readBody().then(...)，让微任务排空再读回包。 */
  for (let i = 0; i < 6 && !res.writableEnded; i++) await new Promise(r => setImmediate(r));
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body: res.body, json, headers: res.headers };
}
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

(async () => {
  /* ---------- ① 一次性迁移：回读校验通过才删旧文件 ---------- */
  {
    const dir = mkDir('migrate');
    const dd = path.join(dir, '.data');
    const legacy = {
      'sk_key_p1.json': 'just-a-plain-string',
      'dir_theme.json': 'dark',
      'sk_key_p1.bak.json': 'older',
      'asr.json': '{"route":"local"}',
      'asr-jobs.json': '[]',
      'search.json': '{"enabled":false}',
      'skills.json': '{"enabled":{}}',
      '.cloud-state.json': '{"lastAt":123}',
      '.cloud-baseline.json': '{"keys":{}}',
      '.cap-cache.json': '{"keep":true}',
    };
    for (const [f, body] of Object.entries(legacy)) write(path.join(dd, f), body);
    write(path.join(dd, 'local-assets', 'index.json'), '[]');

    const { hub } = hubOf(dir);
    const statePath = path.join(dd, 'state.json');
    ok(fs.existsSync(statePath), '迁移没写出 state.json');
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    ok(st.version === 2 && typeof st.checksum === 'string' && st.checksum.length === 64,
      'state.json 不是带 sha256 的 v2 格式');
    ok(hub.readKey('sk_key_p1') === 'just-a-plain-string', '普通字符串没原样搬进状态仓');
    ok(hub.readKey('dir_theme') === 'dark', '业务键搬丢了');
    ok(hub.readKey('asr') === '{"route":"local"}' && hub.readKey('search') === '{"enabled":false}',
      'ASR / 搜索设置没搬进来');
    ok(hub.readKey(CLOUD_STATE_KEY) === '{"lastAt":123}' && hub.readKey(CLOUD_BASE_KEY) === '{"keys":{}}',
      '.cloud-* 没合成内部键');
    const m = hub.stateStore.migrationLegacy;
    ok(m && m.migrated === 8, '迁移回执的键数不对（' + (m && m.migrated) + '）');
    ok(m && m.keys === 1 && m.baks['sk_key_p1.bak.json'] === 'older', '旧 .bak.json 没进迁移快照');

    const left = fs.readdirSync(dd);
    ok(!left.includes('sk_key_p1.json') && !left.includes('sk_key_p1.bak.json'), '旧业务文件没删干净');
    ok(!left.includes('.cloud-state.json') && !left.includes('.cloud-baseline.json'), '旧云状态文件没删干净');
    ok(!left.some(f => f.endsWith('.bak.json')), '盘上还留着 <key>.bak.json');
    ok(left.includes('.cap-cache.json'), '代理自己的运行态被迁移误删');
    ok(fs.existsSync(path.join(dd, 'local-assets', 'index.json')), '资产索引被迁移误删');
    ok(!left.some(f => f.startsWith('.migration-')), '迁移暂存目录没清掉');
    ok(hub.dataList().every(x => !x.key.startsWith('__')), '内部键混进了 /data 清单');
    ok(hub.dataList().some(x => x.key === 'sk_key_p1'), '逻辑视图里看不到搬进来的键');
    /* 开机收尾那一次要留「迁移快照」，把旧 .bak.json 的正文一起收进去；
       否则一次性删掉旧文件之后，那 35 份历史备份就真的没了。 */
    hub.bootBackup();
    const snap = hub.backupStore.list().find(s => s.reason === 'migration');
    ok(!!snap, '首次开机没留迁移快照');
    const bj = JSON.parse(fs.readFileSync(path.join(dd, 'backup.json'), 'utf8'));
    const mig = bj.snapshots.find(s => s.reason === 'migration');
    ok(mig && mig.body.legacyBaks && mig.body.legacyBaks['sk_key_p1.bak.json'] === 'older',
      '迁移快照里没有旧 .bak.json 的正文');
    ok(hub.backupStore.verify().ok === true, '迁移快照自己的校验和对不上');
    /* 重启不再迁移一次，也不再凭空多一份迁移回执 */
    const again = hubOf(dir).hub;
    ok(again.readKey('sk_key_p1') === 'just-a-plain-string' && !again.stateStore.migrationLegacy,
      '第二次开机又迁移了一遍');
  }

  /* ---------- ② 校验和不通过：拒绝写入 + 健康提示 ---------- */
  {
    const dir = mkDir('degraded');
    const first = hubOf(dir).hub;
    first.writeKey('a', 'one');
    const p = path.join(dir, '.data', 'state.json');
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    st.keys.a.body = 'tampered';                 // 故意不动 checksum
    fs.writeFileSync(p, JSON.stringify(st));
    const second = hubOf(dir).hub;
    ok(/校验不通过/.test(second.stateStore.degraded || ''), 'state.json 被改坏却没判成降级');
    let err = '';
    try { second.writeKey('b', 'two'); } catch (e) { err = e.message || ''; }
    ok(/拒绝写入/.test(err), '降级之后仍然允许写入（会把坏数据盖成新数据）');
    ok(second.readKey('a') == null, '读不出内容时把「读不出来」当成「本来就没有」还回了旧值');
    const status = second.backupStore.status();
    ok(status.ok === false && /校验不通过/.test(status.stateDegraded || ''), '健康提示没报出状态仓坏了');
    const res = await call(second.handleData, { url: '/data', method: 'GET', headers: {} });
    ok(res.status === 500 && res.json && res.json.degraded === true, '/data 在降级时没有回 500 + degraded');
  }

  /* ---------- ③ /data/<key> 逻辑视图：原样文本、非法键、删除 ---------- */
  {
    const dir = mkDir('view');
    const { hub, dataDir } = hubOf(dir);
    hub.writeKey('plain', 'dark');
    ok(hub.readKey('plain') === 'dark', '写入的字符串被改写过');
    ok(hub.dataList().some(x => x.key === 'plain' && x.size === 4), '清单里的体积不对');
    let put = await call(hub.handleData, { url: '/data/http_key', method: 'PUT', headers: {}, probeBody: 'raw text' });
    ok(put.status === 200 && hub.readKey('http_key') === 'raw text', 'HTTP 写入没落到状态仓');
    const get = await call(hub.handleData, { url: '/data/http_key', method: 'GET', headers: {} });
    ok(get.status === 200 && get.body === 'raw text', 'HTTP 读回的不是原始文本');
    ok(!fs.existsSync(path.join(dataDir, 'http_key.json')), '又落回了单键文件');
    for (const [k, body] of [['bad key', 'x'], ['ok', ''], ['ok', 'a\u0000b']]) {
      let msg = '';
      try { hub.writeKey(k, body); } catch (e) { msg = e.message || ''; }
      ok(msg.length > 0, '非法键名 / 空内容 / NUL 字节被放行了：' + JSON.stringify([k, body]));
    }
    ok(hub.deleteKey('plain') === true && hub.readKey('plain') == null, '删除没生效');
    ok(hub.backupStore.list().some(s => s.reason === 'before-delete'), '删除前没留快照');
  }

  /* ---------- ④ 快照：去重、轮转 5 份、校验和坏了拒绝恢复 ---------- */
  {
    const dir = mkDir('snap');
    const { hub } = hubOf(dir);
    const b = hub.backupStore;
    hub.writeKey('k', 'v0');
    const first = b.createSnapshot('manual', { force: true });
    ok(first.created === true && typeof first.id === 'string', '手动快照没建成');
    const dup = b.createSnapshot('auto', {});
    ok(dup.created === false && /内容没变/.test(dup.why || ''), '同内容又多留了一份快照');
    for (let i = 1; i <= 7; i++) { hub.writeKey('k', 'v' + i); b.createSnapshot('manual', { force: true }); }
    ok(b.list().length === MAX_SNAPSHOTS, '快照没轮转到 ' + MAX_SNAPSHOTS + ' 份（现在 ' + b.list().length + '）');
    ok(b.verify().ok === true, '新写的快照自己校验不过');
    const ids = b.list().map(s => s.id);
    const pv = b.preview(ids[0]);
    ok(/将覆盖/.test(pv.text) && /同名不覆盖/.test(pv.text), '预览没说清覆盖什么');

    const bp = path.join(dir, '.data', 'backup.json');
    const bj = JSON.parse(fs.readFileSync(bp, 'utf8'));
    bj.snapshots[0].body.state.k.body = 'EVIL';
    fs.writeFileSync(bp, JSON.stringify(bj));
    const second = hubOf(dir).hub;
    ok(second.backupStore.verify().ok === false, '快照正文被改坏却没验出来');
    let err = '';
    try { second.backupStore.restore({ snapshot: ids[0] }); } catch (e) { err = e.message || ''; }
    ok(/校验/.test(err), '校验和对不上却允许恢复：' + (err || '没抛错'));
    ok(second.readKey('k') === 'v7', '拒绝恢复的同时把当前数据改了');
    ok(second.backupStore.status().ok === false, '健康提示没报出快照校验失败');
  }

  /* ---------- ⑤ 恢复：业务键 + 归档 + 资产索引，恢复前强制留一份 ---------- */
  {
    const dir = mkDir('restore');
    const { hub, applied } = hubOf(dir);
    const dd = path.join(dir, '.data');
    const idx = path.join(dd, 'local-assets', 'index.json');
    write(idx, '[{"id":"la1"}]');
    const promptDir = path.join(dir, '库根', '提示词');
    write(path.join(promptDir, 'archived.md'), '# 归档');
    hub.writeKey('k', 'original');
    const id = hub.backupStore.createSnapshot('manual', { force: true }).id;
    hub.writeKey('k', 'changed');
    hub.deleteKey('k');
    write(idx, '[]');
    fs.unlinkSync(path.join(promptDir, 'archived.md'));
    const r = hub.backupStore.restore({ snapshot: id });
    ok(r.ok === true && r.written >= 1, '恢复回执没报写入条数');
    ok(hub.readKey('k') === 'original', '业务键没恢复回来');
    ok(fs.existsSync(path.join(promptDir, 'archived.md')), '提示词归档没恢复回来');
    ok(applied.text === '[{"id":"la1"}]', '资产索引没恢复回来');
    ok(hub.backupStore.list()[0].reason === 'before-restore', '恢复前没强制留一份当前数据的快照');

    const pack = hub.backupStore.exportPack();
    ok(pack.version === 2 && typeof pack.checksum === 'string' && pack.state && pack.prompts,
      '整包导出没带齐版本 / 校验和 / 业务键 / 归档');
    hub.writeKey('k', 'again');
    hub.backupStore.restorePack(pack);
    ok(hub.readKey('k') === 'original', '整包导入没把业务键写回来');
    const broken = Object.assign({}, pack, { checksum: '0'.repeat(64) });
    const err = (() => { try { hub.backupStore.restorePack(broken); return ''; } catch (e) { return e.message || ''; } })();
    ok(/校验和/.test(err) && hub.readKey('k') === 'original', '整包校验和对不上却写了数据');
  }

  /* ---------- ⑥ /backup/* 端点：状态、导出、导入、坏包零写入 ---------- */
  {
    const dir = mkDir('http');
    const { hub } = hubOf(dir);
    hub.writeKey('k', 'value');
    const st = await call(hub.handleBackup, { url: '/backup/status', method: 'GET', headers: {} });
    ok(st.status === 200 && st.json && st.json.ok === true && Array.isArray(st.json.snapshots),
      '/backup/status 没回健康状态');
    const exp = await call(hub.handleBackup, { url: '/backup/export', method: 'GET', headers: {} });
    ok(exp.status === 200 && exp.json && exp.json.pack && exp.json.pack.version === 2,
      '/backup/export 没回出 v2 整包');
    const pack = exp.json.pack;
    hub.writeKey('k', 'changed');
    const imp = await call(hub.handleBackup, {
      url: '/backup/import', method: 'POST', headers: {}, probeBody: JSON.stringify({ pack }),
    });
    ok(imp.status === 200 && imp.json && imp.json.ok === true && hub.readKey('k') === 'value',
      '/backup/import 没把整包恢复回来');
    const badPack = Object.assign({}, pack, { checksum: 'x' });
    const refused = await call(hub.handleBackup, {
      url: '/backup/import', method: 'POST', headers: {}, probeBody: JSON.stringify({ pack: badPack }),
    });
    ok(refused.status === 500 && /校验和/.test(String(refused.json && refused.json.error || '')),
      '坏整包没有回 500');
    ok(hub.readKey('k') === 'value', '坏整包回 500 却把数据改了');
    const v1 = await call(hub.handleBackup, {
      url: '/backup/import', method: 'POST', headers: {}, probeBody: JSON.stringify({ pack: Object.assign({}, pack, { version: 1 }) }),
    });
    ok(v1.status === 500 && /版本/.test(String(v1.json && v1.json.error || '')), 'v1 整包没被拒');
  }

  /* ---------- ⑦ 云同步：三档优先级 + 凭据来源判定 + 状态写回状态仓 ----------
     地址按「页面头 > .env > 内置默认」取，账号密码按「页面头 > .env」取（没有默认）。
     页面只发地址、账号密码留空是常态（凭据留在代理侧 .env），所以 envConfigured 不能把
     CLOUD_WEBDAV_URL 也算进去；状态写不回状态仓时，界面会永远停在「还没有同步过」。 */
  {
    const dir = mkDir('cloud');
    const { hub, logs } = hubOf(dir);
    const DEFAULT_URL = 'https://dav.jianguoyun.com/dav/imago';   // cloudCfg 会去掉尾斜杠
    const keys = ['CLOUD_WEBDAV_URL', 'CLOUD_WEBDAV_USER', 'CLOUD_WEBDAV_PASS'];
    const saved = keys.map(k => process.env[k]);
    process.env.CLOUD_WEBDAV_URL = '';                  // 地址两档都空：该落到内置默认
    process.env.CLOUD_WEBDAV_USER = 'probe@example.com';
    process.env.CLOUD_WEBDAV_PASS = 'probe-pass';
    const st = await call(hub.handleCloud, { url: '/cloud/status', method: 'GET', headers: {} });
    ok(st.status === 200 && st.json && st.json.envConfigured === true,
      '账号密码由代理侧给、URL 留空时，状态没认出凭据已配置');
    ok(st.json && String(st.json.defaultUrl || '').replace(/\/+$/, '') === DEFAULT_URL,
      '/cloud/status 没把内置默认地址交给设置页');
    delete process.env.CLOUD_WEBDAV_USER;
    delete process.env.CLOUD_WEBDAV_PASS;
    const st2 = await call(hub.handleCloud, { url: '/cloud/status', method: 'GET', headers: {} });
    ok(st2.status === 200 && st2.json && st2.json.envConfigured === false,
      '账号或应用密码没配却报了凭据已配置');
    process.env.CLOUD_WEBDAV_USER = 'probe@example.com';
    process.env.CLOUD_WEBDAV_PASS = 'probe-pass';
    /* 故意给一个明文 http 地址：cloudCfg 在协议检查当场抛错（有默认地址也不会出网），
       整条失败路径必须把结果写回状态仓。 */
    await call(hub.handleCloud, {
      url: '/cloud/push', method: 'POST',
      headers: { 'x-cloud-url': 'http://dav.example.com/dav/' }, probeBody: '{}',
    });
    ok(logs.every(s => !/状态写入失败/.test(s)), '云同步状态没写进状态仓（writeKey 没注入）');
    const raw = hub.readKey(CLOUD_STATE_KEY);
    ok(!!raw && /失败/.test(raw), '同步失败后状态仓里没留下这次结果');
    /* 页面没填地址、.env 也没写：落到第三档内置默认，不许再报「还没配置云端地址」。 */
    const cfgDefault = await hub.cloudStore.cloudCfg({ headers: {} });
    ok(cfgDefault.url === DEFAULT_URL, '页面与 .env 都空时没用内置默认地址');
    ok(String(hub.cloudStore.defaultUrl || '').replace(/\/+$/, '') === DEFAULT_URL,
      '云同步 store 没暴露内置默认地址');
    const cfgBlank = await hub.cloudStore.cloudCfg({ headers: { 'x-cloud-url': '   ' } });
    ok(cfgBlank.url === DEFAULT_URL, '页面地址填了空白字符却没当成留空');
    /* 设置页三格留空时不带 x-cloud-user / x-cloud-pass，凭据必须回退到代理侧；
       页面真填了则压过代理侧。cloudCfg 只解析配置，不会真的发请求。 */
    process.env.CLOUD_WEBDAV_URL = 'https://dav.example.com/dav/imago/';
    const cfgEnv = await hub.cloudStore.cloudCfg({ headers: {} });
    ok(cfgEnv.user === 'probe@example.com' && cfgEnv.pass === 'probe-pass',
      '页面账号密码留空时没回退到代理侧凭据');
    const cfgPage = await hub.cloudStore.cloudCfg({
      headers: { 'x-cloud-user': 'page-user', 'x-cloud-pass': 'page-pass' },
    });
    ok(cfgPage.user === 'page-user' && cfgPage.pass === 'page-pass',
      '页面填了账号密码却没压过代理侧');
    ok(cfgEnv.url === 'https://dav.example.com/dav/imago',
      '页面地址留空时没用代理侧的 CLOUD_WEBDAV_URL');
    const cfgPageUrl = await hub.cloudStore.cloudCfg({
      headers: { 'x-cloud-url': 'https://dav.page.example/dav/custom' },
    });
    ok(cfgPageUrl.url === 'https://dav.page.example/dav/custom',
      '页面填了地址却没压过代理侧');
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }

  /* 收尾：还原环境变量、删掉整棵探针目录 */
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  console.log(bad ? '\n✗ data-hub：' + bad + ' / ' + n + ' 项未通过'
    : '\n✓ data-hub：' + n + ' 项判据通过（迁移 / 降级 / 逻辑视图 / 快照 / 恢复 / 端点）');
  process.exitCode = bad ? 1 : 0;
})().catch(e => {
  console.error('✗ data-hub 判据自身出错：' + (e && e.stack || e));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
