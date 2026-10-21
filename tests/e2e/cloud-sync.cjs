#!/usr/bin/env node
/* 云同步到底把哪些键送出机器（用户数据跟着走，只对本机有意义的任务与设置不出机器）。
   判据不看代理自己怎么说，只看对面那台假 WebDAV 真的收到了哪些 PUT 路径：
     · ai_chat / fav_items —— 用户的对话与收藏，要跟着走；
     · asr / asr-jobs / search / render-jobs —— 只对本机有意义（任务指向这台机器上的文件），不许出机器；
     · sk_key_* —— 平台密钥默认不出机器，带 x-cloud-keys: 1 才参与（这一条也要能成立，否则「勾选才传」是假的）。
   云端用只监听 127.0.0.1 的假 WebDAV 顶替：cloudCfg 明写了回环 http 例外，
   数据只写 harness 起的隔离实例（.data-probe-*），跑完连目录一起删。 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const h = require('./harness.cjs');

const MUST_UP = ['ai_chat', 'fav_items'];
const MUST_NOT = ['asr', 'asr-jobs', 'search', 'render-jobs'];

function startDav() {
  const puts = [];
  const srv = http.createServer((req, res) => {
    if (!/^Basic /i.test(String(req.headers.authorization || ''))) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="dav"' }); return res.end();
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const name = decodeURIComponent(String(req.url || '').split('/').filter(Boolean).pop() || '');
      if (req.method === 'PUT' && /\.json$/.test(name)) puts.push(name);
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'content-type': 'application/xml' });
        return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>');
      }
      if (req.method === 'MKCOL') { res.writeHead(201); return res.end(); }
      /* 云端一份都没有：本机这些键全被判成「往上走」，正好用来数清到底走了哪些。 */
      if (req.method === 'GET') { res.writeHead(404); return res.end(); }
      res.writeHead(200); res.end();
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    resolve({ url: 'http://127.0.0.1:' + srv.address().port + '/dav', puts,
      close: () => new Promise(r => srv.close(r)) });
  }));
}

(async () => {
  let proxy, dav;
  try {
    dav = await startDav();
    proxy = await h.startProxy();
    const call = (cmd, keys) => fetch(proxy.base + '/cloud/' + cmd, {
      method: 'POST',
      headers: Object.assign({
        cookie: proxy.cookie,
        'content-type': 'application/json',
        'x-cloud-url': dav.url, 'x-cloud-user': 'probe', 'x-cloud-pass': 'probe-pass',
      }, keys ? { 'x-cloud-keys': '1' } : {}),
      body: '{}',
    });

    /* 一次同步要覆盖到的六份键：四份该被拦、两份该上去，再加一份密钥形状的文件。 */
    const seed = {};
    for (const k of MUST_UP.concat(MUST_NOT)) seed[k] = { revision: 1, probe: k, updatedAt: new Date().toISOString() };
    seed.sk_key_probe = { v: 1, value: 'sk-probe-not-a-real-key' };
    for (const [k, v] of Object.entries(seed)) {
      fs.writeFileSync(path.join(proxy.dataDir, k + '.json'), JSON.stringify(v), 'utf8');
    }

    const mark = dav.puts.length;
    const r = await call('sync');
    if (r.status !== 200) throw new Error('同步应 200，实际 ' + r.status + '：' + await r.text());
    const j = await r.json();
    if (!j.ok) throw new Error('同步没成：' + JSON.stringify(j));
    const went = dav.puts.slice(mark);
    if (j.failed && j.failed.length) throw new Error('同步里有键失败：' + JSON.stringify(j.failed));

    for (const k of MUST_UP) {
      if (went.includes(k + '.json')) continue;
      throw new Error('用户数据该上云，实际收到的 PUT 是：' + JSON.stringify(went) + '（回执：' + j.message + '）');
    }
    const leaked = MUST_NOT.map(k => k + '.json').filter(f => went.includes(f));
    if (leaked.length) throw new Error('这些只对本机有关系的键被传出去了：' + JSON.stringify(leaked));
    /* 回执也要跟盘上事实一致：明细里不该出现被跳过的那四个键（说「没传」而真没传）。 */
    const said = (j.details || []).map(String);
    const lied = MUST_NOT.filter(k => said.some(s => s.indexOf(k) >= 0));
    if (lied.length) throw new Error('回执里出现了本该跳过的键：' + JSON.stringify({ 键: lied, 明细: said }));

    const m2 = dav.puts.length;
    const j2 = await (await call('sync', true)).json();
    const went2 = dav.puts.slice(m2);
    if (!j2.ok) throw new Error('带密钥那一趟同步没成：' + JSON.stringify(j2));
    if (!went2.includes('sk_key_probe.json')) {
      throw new Error('勾了「同步密钥」（x-cloud-keys: 1）就该参与上传，实际 PUT 是：' + JSON.stringify(went2));
    }
    const still = MUST_NOT.map(k => k + '.json').filter(f => went2.includes(f));
    if (still.length) throw new Error('带不带密钥都不该把这几份送出去：' + JSON.stringify(still));

    console.log('✓ 云同步取键通过（上去 ' + went.length + ' 份：对话与收藏都在；' +
      MUST_NOT.join(' / ') + ' 一份都没出机器；密钥默认不传、勾上 x-cloud-keys 才传 · 隔离实例）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (dav) await dav.close();
    if (proxy) await proxy.stop();
  }
})();
