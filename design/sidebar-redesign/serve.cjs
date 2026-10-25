#!/usr/bin/env node
/* 本地预览用的静态服务器（只为看稿子方便，不是产品的一部分）。
   用法：node design/sidebar-redesign/serve.cjs 8097
   然后打开 http://127.0.0.1:8097/
   —— 直接双击 index.html 也能看（这一稿不取任何外部数据，file:// 就够）。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function start(portArg) {
  const port = Number(portArg) || 8097;
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
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
      const base = 'http://127.0.0.1:' + port + '/';
      console.log('设计稿预览：' + base);
      resolve({ base, port, stop: () => new Promise(r => server.close(() => r())) });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start(process.argv[2]).catch(e => { console.error(e); process.exit(1); });
}
