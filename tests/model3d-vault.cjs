#!/usr/bin/env node
/* 白膜库服务端：旧布局迁移到默认库、多库、模型 / 场景 / 场景组、导入 3D 文件。
   不开浏览器、不碰用户目录（整个库根是 mkdtemp 出来的）。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModel3dRoutes } = require('../server/routes/model3d.js');

let n = 0;
const ok = (c, m) => { n += 1; assert.ok(c, m); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imago-model3d-'));
const base = path.join(root, '白膜');
const oldGroup = path.join(base, '角色');
fs.mkdirSync(oldGroup, { recursive: true });
fs.writeFileSync(path.join(oldGroup, '少女.json'), JSON.stringify({ v: 3, kind: 'model', name: '少女' }));
fs.writeFileSync(path.join(base, '旧模型.json'), JSON.stringify({ v: 3, kind: 'model', name: '旧模型' }));
fs.mkdirSync(path.join(base, '_模型文件'), { recursive: true });
fs.writeFileSync(path.join(base, '_模型文件', '长凳.fbx'), Buffer.from('FBXBINARY'));

function fakeReq(buf) {
  const { EventEmitter } = require('node:events');
  const req = new EventEmitter();
  req.headers = {};
  req.method = 'POST';
  setImmediate(() => {
    if (buf && buf.length) req.emit('data', buf);
    req.emit('end');
  });
  return req;
}
function fakeRes() {
  return {
    status: 0, headers: null, body: '', headersSent: false,
    writeHead(code, hdrs) { this.status = code; this.headers = hdrs || {}; this.headersSent = true; },
    end(s) { this.body += s == null ? '' : String(s); },
    on() {}, once() {}, emit() {}, removeListener() {},
    req: { headers: {} },
  };
}
function readBody(req, res, limit) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { res.writeHead(413, {}); res.end('{}'); resolve(null); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const routes = createModel3dRoutes({ readBody, log: () => {}, localRoot: () => root });
const call = (method, url, body) => new Promise(resolve => {
  const u = new URL('http://local' + url);
  const res = fakeRes();
  const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = fakeReq(buf);
  req.method = method;
  req.url = url;
  const done = () => resolve({ status: res.status, headers: res.headers, text: res.body });
  res.end = s => { res.body += s == null ? '' : String(s); done(); };
  res.write = c => { res.body += String(c); return true; };
  routes.handleModel3d(req, res, u);
  setTimeout(done, 300);
});

(async () => {
  /* 旧布局迁移 */
  {
    const r = await call('GET', '/model3d');
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.library === '默认库', '自动建默认库并选中');
    ok(d.libraries.some(x => x.id === '默认库'), '库列表里有默认库');
    ok(d.models.some(m => m.id === '角色/少女') && d.models.some(m => m.id === '旧模型'), '旧根模型与旧组都迁进默认库');
    ok(fs.existsSync(path.join(base, '默认库', '模型', '角色', '少女.json')), '旧组路径保留');
    ok(fs.existsSync(path.join(base, '默认库', '_模型文件', '长凳.fbx')), '_模型文件 跟着库走');
  }

  /* 新库 */
  {
    const r = await call('POST', '/model3d/library/save', { name: '系列A' });
    ok(r.status === 200, '新建库');
    const list = JSON.parse((await call('GET', '/model3d?library=' + encodeURIComponent('系列A'))).text);
    ok(list.library === '系列A' && list.models.length === 0 && list.scenes.length === 0, '新库是空的');
  }

  /* 模型保存 / 读取 / 改名 / 删除 */
  {
    const doc = { v: 3, kind: 'model', name: '椅子', scene: { nodes: [{ kind: 'prim', id: 'p', shape: 'box' }], cams: [], view: {} } };
    const r = await call('POST', '/model3d/save', { library: '系列A', kind: 'model', name: '椅子', group: '', model: doc });
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.id === '椅子' && d.library === '系列A', '保存模型到指定库');
    const f = await call('GET', '/model3d/file?library=' + encodeURIComponent('系列A') + '&kind=model&id=' + encodeURIComponent('椅子'));
    ok(f.status === 200 && JSON.parse(f.text).name === '椅子', '读回模型');
    const mv = await call('POST', '/model3d/save', { library: '系列A', kind: 'model', id: '椅子', name: '长椅', group: '', model: doc });
    ok(mv.status === 200 && JSON.parse(mv.text).id === '长椅', '模型改名');
  }

  /* 模型组：建组 / 移组 / 改组名 / 删组退回未分组 */
  {
    const doc = { v: 3, kind: 'model', name: '长椅', scene: { nodes: [], cams: [], view: {} } };
    const cg = await call('POST', '/model3d/model-group/create', { library: '系列A', name: '角色' });
    ok(cg.status === 200 && fs.existsSync(path.join(base, '系列A', '模型', '角色')), '新建模型组');
    const mv = await call('POST', '/model3d/save', { library: '系列A', kind: 'model', id: '长椅', name: '长椅', group: '角色', model: doc });
    ok(mv.status === 200 && fs.existsSync(path.join(base, '系列A', '模型', '角色', '长椅.json')), '模型移进组');
    const rg = await call('POST', '/model3d/model-group/rename', { library: '系列A', from: '角色', to: '人物' });
    ok(rg.status === 200 && fs.existsSync(path.join(base, '系列A', '模型', '人物', '长椅.json')), '模型组改名');
    ok(JSON.parse(fs.readFileSync(path.join(base, '系列A', '模型', '人物', '长椅.json'), 'utf8')).group === '人物', '组改名回写 doc.group');
    const dg = await call('POST', '/model3d/model-group/delete', { library: '系列A', from: '人物' });
    ok(dg.status === 200 && fs.existsSync(path.join(base, '系列A', '模型', '长椅.json')), '删模型组后模型退回未分组');
  }

  /* 场景 / 场景组 */
  {
    const doc = { v: 3, kind: 'scene', name: '街景', group: '第一幕', scene: { nodes: [], cams: [], view: {} } };
    const r = await call('POST', '/model3d/save', { library: '系列A', kind: 'scene', name: '街景', group: '第一幕', model: doc });
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.id === '第一幕/街景', '场景按组保存');
    const cg = await call('POST', '/model3d/scene-group/create', { library: '系列A', name: '第二幕' });
    ok(cg.status === 200, '新建场景组');
    const rn = await call('POST', '/model3d/scene-group/rename', { library: '系列A', from: '第二幕', to: '尾声' });
    ok(rn.status === 200 && fs.existsSync(path.join(base, '系列A', '场景', '尾声')), '场景组改名');
    const del = await call('POST', '/model3d/scene-group/delete', { library: '系列A', from: '第一幕' });
    ok(del.status === 200 && fs.existsSync(path.join(base, '系列A', '场景', '街景.json')), '删场景组后场景落到未分组');
  }

  /* 3D 文件按库上传 / 读取 */
  {
    const r = await call('POST', '/model3d/asset?library=' + encodeURIComponent('系列A') + '&name=' + encodeURIComponent('长凳.fbx'), Buffer.from('FBX2'));
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.file === '_模型文件/长凳.fbx', '3D 文件落到当前库');
    const got = await call('GET', '/model3d/asset?library=' + encodeURIComponent('系列A') + '&name=' + encodeURIComponent('_模型文件/长凳.fbx'));
    ok(got.status === 200 && got.text.indexOf('FBX2') >= 0, '按库取回 3D 文件');
  }

  /* 删模型 / 删库 */
  {
    const del = await call('POST', '/model3d/delete', { library: '系列A', kind: 'model', id: '长椅' });
    ok(del.status === 200 && !fs.existsSync(path.join(base, '系列A', '模型', '长椅.json')), '删除模型');
    const lib = await call('POST', '/model3d/library/delete', { id: '系列A' });
    ok(lib.status === 200 && !fs.existsSync(path.join(base, '系列A')), '删库移进 trash');
    ok(fs.readdirSync(path.join(base, '.trash')).length === 1, 'trash 里有那一份');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ model3d-vault：' + n + ' 项通过');
})().catch(e => { console.error(e); try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { /* 清理失败不影响结论 */ } process.exit(1); });
