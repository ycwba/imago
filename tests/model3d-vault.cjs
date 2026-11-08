#!/usr/bin/env node
/* 白膜库的服务端路由：写到隔离的临时库根，逐条验落点、改名移组、越界拒绝、缩略图、删除。
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
const modelsRoot = path.join(root, '白膜');

/* 假的 req/res：readBody 只需要 'data' / 'end' 两个事件；res 把回包拼回来 */
function fakeReq(buf) {
  const { EventEmitter } = require('node:events');
  const req = new EventEmitter();
  req.headers = {};
  setImmediate(() => {
    if (buf && buf.length) req.emit('data', buf);
    req.emit('end');
  });
  return req;
}
function fakeRes() {
  return {
    status: 0, headers: null, body: '', chunks: [],
    headersSent: false,
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
  /* 流式回包（GET file/thumb/asset 走 createReadStream.pipe）也要等它落完 */
  const done = () => resolve({ status: res.status, headers: res.headers, text: res.body, res });
  res.end = s => { res.body += s == null ? '' : String(s); done(); };
  res.write = c => { res.body += String(c); return true; };
  routes.handleModel3d(req, res, u);
  setTimeout(done, 300);
});

(async () => {
  /* ---------- 空库 ---------- */
  {
    const r = await call('GET', '/model3d');
    const d = JSON.parse(r.text);
    ok(r.status === 200, '空库列表 200');
    ok(Array.isArray(d.models) && d.models.length === 0, '空库没有模型');
    ok(d.dir === modelsRoot, '列表报出库根：' + d.dir);
  }

  /* ---------- 保存 ---------- */
  const doc = { v: 1, name: '少女', group: '角色', scene: { nodes: [] }, anim: { duration: 4, fps: 24, tracks: [] } };
  const thumb = 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64');
  {
    const r = await call('POST', '/model3d/save', { name: '少女', group: '角色', model: doc, thumb });
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.ok, '保存成功');
    ok(d.id === '角色/少女', '返回的 id 是「组/名」：' + d.id);
    ok(fs.existsSync(path.join(modelsRoot, '角色', '少女.json')), '模型落在 白膜/角色/少女.json');
    ok(fs.existsSync(path.join(modelsRoot, '角色', '少女.png')), '缩略图并落');
    const saved = JSON.parse(fs.readFileSync(path.join(modelsRoot, '角色', '少女.json'), 'utf8'));
    ok(saved.name === '少女' && saved.group === '角色' && saved.ts > 0, '模型文件里写着身份与时间');
  }
  {
    const r = await call('GET', '/model3d');
    const d = JSON.parse(r.text);
    ok(d.models.length === 1 && d.models[0].thumb === true, '列表里能看见缩略图标记');
    ok(d.groups.length === 1 && d.groups[0].name === '角色' && d.groups[0].count === 1, '组与计数');
  }

  /* ---------- 读 / 缩略图 ---------- */
  {
    const r = await call('GET', '/model3d/file?id=' + encodeURIComponent('角色/少女'));
    ok(r.status === 200 && JSON.parse(r.text).name === '少女', '按 id 读回模型');
    const t = await call('GET', '/model3d/thumb?id=' + encodeURIComponent('角色/少女'));
    ok(t.status === 200 && t.text.indexOf('PNGDATA') >= 0, '缩略图取回');
    const none = await call('GET', '/model3d/thumb?id=' + encodeURIComponent('角色/没有这个'));
    ok(none.status === 404, '没有缩略图时 404');
  }

  /* ---------- 改名 / 移组 = 移动文件 ---------- */
  {
    const r = await call('POST', '/model3d/save', { id: '角色/少女', name: '奔跑的少女', group: '人物', model: doc });
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.id === '人物/奔跑的少女', '改名 + 移组之后 id 跟着变：' + d.id);
    ok(!fs.existsSync(path.join(modelsRoot, '角色', '少女.json')), '旧文件被挪走');
    ok(fs.existsSync(path.join(modelsRoot, '人物', '奔跑的少女.json')), '新位置有文件');
    ok(!fs.existsSync(path.join(modelsRoot, '角色')), '空组目录被收掉');
  }

  /* ---------- 越界与非法 ---------- */
  {
    const cases = [
      ['../偷偷出去', 400],
      ['角色/../../x', 400],
      ['/abs/path', 400],
      ['角色/少女/多一级', 400],
    ];
    for (const [id, want] of cases) {
      const r = await call('GET', '/model3d/file?id=' + encodeURIComponent(id));
      ok(r.status === want, '越界 id「' + id + '」被拒（' + r.status + '）');
    }
    const bad = await call('POST', '/model3d/save', { name: '', group: '', model: doc });
    ok(bad.status === 400, '空名字被拒');
    const reserved = await call('POST', '/model3d/save', { name: 'x', group: '_模型文件', model: doc });
    ok(reserved.status === 400, '下划线开头的组名被拒（留给导入的 3D 文件）');
    const noModel = await call('POST', '/model3d/save', { name: 'x', group: '' });
    ok(noModel.status === 400, '没有 model 被拒');
  }

  /* ---------- 导入 3D 文件 ---------- */
  {
    const r = await call('POST', '/model3d/asset?name=' + encodeURIComponent('长凳.fbx'), Buffer.from('FBXBINARY'));
    const d = JSON.parse(r.text);
    ok(r.status === 200 && d.file === '_模型文件/长凳.fbx', '导入落在 _模型文件/ 下：' + d.file);
    const again = await call('POST', '/model3d/asset?name=' + encodeURIComponent('长凳.fbx'), Buffer.from('FBX2'));
    const d2 = JSON.parse(again.text);
    ok(d2.file === '_模型文件/长凳-2.fbx', '重名不覆盖，加 -2：' + d2.file);
    const got = await call('GET', '/model3d/asset?name=' + encodeURIComponent('_模型文件/长凳.fbx'));
    ok(got.status === 200 && got.text.indexOf('FBXBINARY') >= 0, '导入的文件能取回');
    ok(got.headers['Content-Type'] === 'application/octet-stream', 'mime 按扩展名给');
    const badExt = await call('POST', '/model3d/asset?name=' + encodeURIComponent('坏.exe'), Buffer.from('x'));
    ok(badExt.status === 400, '不认识的扩展名被拒');
    const empty = await call('POST', '/model3d/asset?name=' + encodeURIComponent('空.obj'), Buffer.alloc(0));
    ok(empty.status === 400, '空文件被拒');
  }

  /* ---------- 删除 ---------- */
  {
    const r = await call('POST', '/model3d/delete', { id: '人物/奔跑的少女' });
    ok(r.status === 200, '删除成功');
    ok(!fs.existsSync(path.join(modelsRoot, '人物', '奔跑的少女.json')), '模型文件没了');
    ok(fs.existsSync(path.join(modelsRoot, '_模型文件', '长凳.fbx')), '删模型不动导入的 3D 文件');
    const againList = JSON.parse((await call('GET', '/model3d')).text);
    ok(againList.models.length === 0, '列表里也没了');
    const bad = await call('POST', '/model3d/delete', { id: '../x' });
    ok(bad.status === 400, '删除时也拦越界 id');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ model3d-vault：' + n + ' 项通过');
})().catch(e => { console.error(e); try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { /* 清理失败不影响结论 */ } process.exit(1); });
