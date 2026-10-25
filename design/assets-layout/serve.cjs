#!/usr/bin/env node
/* 本地预览用的静态服务器（只为看稿子方便，不是产品的一部分）。
   用法：node design/assets-layout/serve.cjs 8094
   然后打开 http://127.0.0.1:8094/design/assets-layout/index.html

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
  /* 0 = 让系统给一个空闲端口（出图脚本要的就是这个，别把 0 当成「没给」）。
     没给参数时才用默认的 8094。 */
  const port = (portArg === undefined || portArg === null || portArg === '')
    ? 8094 : Number(portArg);
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/design/assets-layout/index.html';
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
      /* 端口是 0 时由系统挑一个 —— 要报真实端口回去，别把 0 写进地址。 */
      const real = server.address() && server.address().port ? server.address().port : port;
      const base = 'http://127.0.0.1:' + real + '/';
      console.log('设计稿预览：' + base + 'design/assets-layout/index.html');
      resolve({ base, port: real, stop: () => new Promise(r => server.close(() => r())) });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start(process.argv[2]).catch(e => { console.error(e); process.exit(1); });
}
