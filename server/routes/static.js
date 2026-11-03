/* 静态资源与 SPA 旧地址重定向。只放行工作台前端资源（根级单文件 + web/ 子树）。 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { serveStatic } = require('../static.js');

/* 旧地址 302 的映射从客户端路由表**现派生**（「路由表只有 web/core/routes.js 一份」）：
   routes.js 是经典脚本（shell.html <script> 直挂），Node 侧拿不到 import，
   就照 tests/spa.cjs 的同一套办法在沙箱里跑一遍、取它身上的 alias。
   客户端补了别名、服务端不用再抄一遍 —— 以前两份拷贝就是这么漂开的
   （客户端保留入站查询串、服务端 studio 那一族整条丢弃，同一件事两层行为）。
   不派生的键：'' 与 '/'（根由 FILE_MAP 直出 shell.html）、'app.html'（同上，旧壳入口）。 */
const SPA_REDIRECT_EXCLUDED = new Set(['', '/', 'app.html']);
function deriveSpaRedirect() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../web/core/routes.js'), 'utf8'),
      sandbox, { filename: 'web/core/routes.js' });
    const R = sandbox.window.WB_ROUTES || {};
    const out = {};
    /* 本名页也要 302（磁盘上没有 director.html 这些文件，直接打开旧路径要落到外壳的 hash） */
    for (const p of R.pages || []) { if (p && p.file) out['/' + p.file] = p.file; }
    for (const [from, to] of Object.entries(R.alias || {})) {
      if (!SPA_REDIRECT_EXCLUDED.has(from) && to) out['/' + from] = to;
    }
    return out;
  } catch { return {}; }   // 读不到路由表（不可能，除非仓库被搬空）：退成没有重定向，静态服务照常
}
const SPA_REDIRECT = deriveSpaRedirect();
const FILE_MAP = {
  '/': 'shell.html', '/app.html': 'shell.html', '/shell.html': 'shell.html',
  '/sidebar.js': 'web/ui/sidebar.js', '/assetlib.js': 'web/domain/assetlib.js',
};
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return String(s == null ? '' : s); } }

function handleStatic(req, res, ctx) {
  const root = ctx.root;
  const mime = ctx.mime;
  const urlPath = safeDecode(req.url.split('?')[0]);
  if (SPA_REDIRECT[urlPath]) {
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    let dest = SPA_REDIRECT[urlPath];
    /* studio 一族只对 t= 做**归一化**（客户端 web/app.js 的语义是「入站查询原样保留」），
       其余参数原样跟过去 —— 以前整条查询被丢弃，老书签 / 外部链接 / sidebar.js 那条 location.replace
       带进来的载荷就断在这一跳。 */
    if (dest.indexOf('studio.html') === 0) {
      const qs = new URLSearchParams(search.replace(/^\?/, ''));
      const t = qs.get('t');
      if (t === 'video' || t === 'image' || t === 'audio') dest = 'studio.html?t=' + t;
      qs.delete('t');
      const rest = qs.toString();
      if (rest) dest += (dest.indexOf('?') >= 0 ? '&' : '?') + rest;
    } else if (search && dest.indexOf('?') < 0) {
      dest += search;
    }
    res.writeHead(302, { Location: '/shell.html#' + dest, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  let file = FILE_MAP[urlPath];
  if (!file) {
    const single = /^\/[A-Za-z0-9._-]+$/.test(urlPath);
    const webTree = /^\/web\/[A-Za-z0-9._\/-]+$/.test(urlPath) && !urlPath.includes('..') && !/\/\./.test(urlPath);
    if ((!single && !webTree) || urlPath.includes('..') || /^\/\./.test(urlPath)) {
      res.writeHead(404); res.end('not found'); return true;
    }
    if (!/\.(html|js|cjs|css|png|jpe?g|webp|gif|svg|ico|json|mjs|mp4|webm|woff2?|mp3|wav|m4a|aac|ogg|flac|srt|vtt|ass|txt)$/i.test(urlPath)) {
      res.writeHead(404); res.end('not found'); return true;
    }
    if (/^\/(proxy\.(js|log|out\.log)|package(-lock)?\.json|启动\.bat)$/i.test(urlPath)) { res.writeHead(404); res.end('not found'); return true; }
    file = urlPath;
  }
  const full = path.resolve(root, file.replace(/^\/+/, ''));
  if (!full.startsWith(path.resolve(root) + path.sep)) { res.writeHead(404); res.end('not found'); return true; }
  serveStatic(req, res, full, path.extname(file), mime);
  return true;
}
module.exports = { handleStatic, SPA_REDIRECT, FILE_MAP };
