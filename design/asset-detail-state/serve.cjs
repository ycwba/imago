#!/usr/bin/env node
/* 本地预览用的静态服务器（只为看稿子方便，不是产品的一部分）。
   用法：node design/asset-detail-state/serve.cjs 8095
   然后打开 http://127.0.0.1:8095/design/asset-detail-state/index.html

   根取**仓库根**而不是本目录：这一稿的令牌与公共件直接引用产品的真文件
   （index.html 里 ../../web/styles/tokens.css 等），要让那些相对路径解析到，
   就得从仓库根起服务。只监听 127.0.0.1，不出本机。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
};

function start(portArg) {
  /* 0 = 让系统给一个空闲端口（出图脚本要的就是这个，别把 0 当成「没给」）。 */
  const port = (portArg === undefined || portArg === null || portArg === '')
    ? 8095 : Number(portArg);
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/design/asset-detail-state/index.html';
    const file = path.join(root, path.normalize(rel).replace(/^[\\/]+/, ''));
    if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const real = server.address() && server.address().port ? server.address().port : port;
      const base = 'http://127.0.0.1:' + real + '/';
      console.log('设计稿预览：' + base + 'design/asset-detail-state/index.html');
      resolve({ base, port: real, stop: () => new Promise(r => server.close(() => r())) });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start(process.argv[2]).catch(e => { console.error(e); process.exit(1); });
}
