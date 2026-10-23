/* 静态资源与 SPA 旧地址重定向。只放行工作台前端资源（根级单文件 + web/ 子树）。 */
'use strict';
const path = require('path');
const { serveStatic } = require('../static.js');

const SPA_REDIRECT = {
  '/director.html': 'director.html',
  '/favorites.html': 'favorites.html', '/roles.html': 'favorites.html',
  '/usage.html': 'usage.html', '/usage': 'usage.html',
  '/assets.html': 'assets.html', '/settings.html': 'settings.html', '/chars.html': 'chars.html',
  '/canvas.html': 'canvas.html',
  '/skills.html': 'settings.html',
  '/studio.html': 'studio.html',
  '/image.html': 'studio.html?t=image', '/image-gen.html': 'studio.html?t=image',
  '/video.html': 'studio.html?t=video', '/video-gen.html': 'studio.html?t=video',
  '/audio.html': 'studio.html?t=audio', '/audio-gen.html': 'studio.html?t=audio',
};
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
    if (dest.indexOf('studio.html') === 0) {
      const m = /[?&]t=(video|image|audio)/.exec(search);
      if (m) dest = 'studio.html?t=' + m[1];
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
