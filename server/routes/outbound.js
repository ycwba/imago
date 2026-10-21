/* 出站字节通道：/getfile（转存取回）、/s3put（流式上传）、/asset（本机优先）、/fetch、/getv。
   每条都只走 takeOutboundUrl 的护栏；这里只做请求分发与流。 */
'use strict';

function createOutboundRoutes(ctx) {
  const {
    takeOutboundUrl, log, upRequest, failUpstream, pipeUpstream, passthroughHeaders,
    guardOutboundUrl, safeOutboundUrl, keyOf, assetInfoOf, assetStore,
    localAssetEntry, localAssetRepair, localFileFromEntry, serveLocalFile, s3putStream,
  } = ctx;

  async function handleOutbound(req, res) {
    if (req.url.startsWith('/getfile?url=')) {
      // 取回通道：把外部 https 资源（如 VGENV CDN 的视频）以同源方式流给浏览器
      // 用途：把非 SparkCine 资产转存成 SparkCine 资产（参考视频 / 参考音频）
      const target = await takeOutboundUrl(req, res, '/getfile?url=', 'getfile');
      if (!target) return;
      log(`[getfile] GET ${target.slice(0, 120)}`);
      /* 跟随重定向：**每一跳都重新过完整护栏**（含 DNS 解析到内网的判定）。
         以前重定向目标只过 safeOutboundUrl（纯字面量），*.nip.io / *.sslip.io 这类
         「看着是公网域名、实际解析到 127.0.0.1」的地址借一次 302 就能进内网（SSRF）。
         限制 3 跳；上一跳的响应必须主动 resume()，否则 socket 挂在那不走。 */
      const fetchHop = (url, hops) => {
        const up = upRequest(url, {
          method: 'GET',
          headers: { 'accept': '*/*', 'accept-encoding': 'identity' },
        }, ur => {
          log(`  → ${ur.statusCode}`);
          if (ur.statusCode >= 300 && ur.statusCode < 400 && ur.headers.location) {
            ur.resume();                                     // 丢弃这一跳的响应体
            if (hops >= 3) { failUpstream(res, '重定向次数过多（超过 3 跳）', 'getfile'); return; }
            let next = '';
            try { next = new URL(ur.headers.location, url).toString(); } catch {}
            if (!next) { failUpstream(res, '重定向目标地址无法解析', 'getfile'); return; }
            guardOutboundUrl(next).then(u2 => fetchHop(u2, hops + 1), e => failUpstream(res, e.message, 'getfile 重定向'));
            return;
          }
          /* 把上游的长度**原样透出**（不 CORS 敏感，客户端读得到就能算下载进度）——
             以前一个头都没有，于是「正在把产物存到本机」只能显示「正在存 N 份」，
             一个 200MB 的视频下到 5% 与 95% 在界面上长得一模一样，用户只能干等。
             没有长度（chunked）时客户端会看到 null，按「大小未知」显示（不假装有进度）。
             本机实测：开着 Windows 系统代理（Clash 一类，走上面的 CONNECT 隧道）时，
             jsdelivr 的响应常被中转**重新分块、丢掉 Content-Length** —— 那是隧道那一跳的事实，
             不是这段透传坏了（PROXY_OFF=1 直连同一个地址，头原样到达）。别去改这里找 bug。 */
          const len = Number(ur.headers['content-length'] || 0) || null;
          const hd = {
            'Content-Type': ur.headers['content-type'] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
          };
          if (len) hd['Content-Length'] = String(len);
          res.writeHead(ur.statusCode, hd);
          pipeUpstream(ur, res, 'getfile');
        });
        up.on('error', e => { log(`  → getfile error: ${e.message}`); failUpstream(res, e.message, 'getfile'); });
        up.end();
      };
      fetchHop(target, 0);
      return;
    }
    if (req.url.startsWith('/s3put?url=')) {
      // 素材上传通道：浏览器无法直传 S3（跨域），由代理携带签名头转发 PUT。
      // 请求体流式转发、进度以 NDJSON 帧回给页面（见 s3putStream）。
      const target = await takeOutboundUrl(req, res, '/s3put?url=', 's3put');
      if (!target) return;
      s3putStream(req, res, target);
      return;
    }
    if (req.url.startsWith('/asset/')) {
      // 资产通道：本地生成的资产优先（语音等同步产物），其余现场解析上游最新签名链接并流给浏览器
      const m = req.url.match(/^\/asset\/([A-Za-z0-9_-]+)(\?|$)/);
      if (!m) { res.writeHead(400); res.end('bad id'); return; }
      const q = new URL(req.url, 'http://x').searchParams;
      let localEnt = localAssetEntry(m[1]);
      let localF = localFileFromEntry(localEnt);
      /* 索引里没有（被挤出上限）或文件被删：这是「真要取这一份」的入口，才做一次补建。
         普通读路径不补建 —— 那会让每个不存在的 id 都扫一遍 .assets（轮询会放大）。 */
      if (!localF) {
        const repaired = localAssetRepair(m[1]);
        if (repaired) { localEnt = repaired; localF = localFileFromEntry(repaired); }
      }
      if (localF) { serveLocalFile(req, res, localF, q, localEnt); return; }
      /* 本地文件没了，但索引里记着这一份是从哪个外链取回来的（自动镜像时写下的）→ 回源。
         这是「API/本地三级回退」的中间一级：没有它，本地文件一被删就只剩 404，
         界面据此判成「已删除」，而上游那份其实可能还取得到（地址过期了也能重新从列表换一份新的）。
         绕一跳 /getv 而不是直接 302 到外链：页面因此始终同源，签名地址、Range、跨域那些问题一个都不会冒出来。 */
      const up0 = safeOutboundUrl(String((localEnt || {}).upstream || ''));
      if (up0) {
        res.writeHead(302, { 'Location': '/getv?url=' + encodeURIComponent(up0), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const key = (req.headers.authorization || '').replace(/^Bearer\s*/, '') || (assetStore ? keyOf(assetStore.keyEnv) : '');
      assetInfoOf(m[1], key).then(info => {
        // Range 透传给 CDN：视频缩略图只取元数据、播放器可拖动进度，不再整段回源
        /* 视频拖进度是几十条 Range：每条都 `connection: close` 就要重建一次 TLS。
           改走按 host 复用的 keep-alive 池 —— Node 的 Agent 键里含 host:port，不会把 A 的
           socket 发给 B；guardedLookup 仍在**建连**时跑（复用的是已经过闸的那条连接）。 */
        const upHeaders = { 'user-agent': 'local-workbench' };
        if (req.headers.range) upHeaders.range = req.headers.range;
        upRequest(info.url, { keepAlive: true, headers: upHeaders }, ir => {
          /* 状态码原样透传、失败响应绝不缓存 —— 判据在 passthroughHeaders（与 /getv 同一份）。
             这一份的特别处只在：成功时用索引里记的 mime，并且同一 URL 内容恒定 → 盖一年 immutable，
             未命中才回源（失败仍然 no-store，见公共层那段注释）。 */
          const { st, h } = passthroughHeaders(ir.headers, {
            status: ir.statusCode,
            okType: info.mime || ir.headers['content-type'] || 'application/octet-stream',
            cacheOk: 'public, max-age=31536000, immutable',
            /* 用 ir.statusCode 现判，别读同一句里的 st（它还没赋值，TDZ 一抛就整条 502） */
            disposition: (!q.get('dl') || ir.statusCode >= 400) ? '' : `attachment; filename*=UTF-8''${encodeURIComponent(q.get('name') || 'image.png')}`,
          });
          res.writeHead(st, h);
          pipeUpstream(ir, res, '资产取回');
        }).on('error', e => failUpstream(res, e.message, '资产取回失败')).end();
      }).catch(e => {
        res.writeHead((e && e.status) || 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(String((e && e.message) || e));
      });
      return;
    }
    if (req.url.startsWith('/fetch?url=')) {
      // 素材下载通道：把任意 https 图片经本地代理取回，绕过浏览器跨域限制（网络瞬断自动重试 2 次）
      const target = await takeOutboundUrl(req, res, '/fetch?url=', 'fetch');
      if (!target) return;
      let attempt = 0;
      const go = () => {
        attempt++;
        const up = upRequest(target, { headers: { 'user-agent': 'local-workbench', connection: 'close' } }, ur => {
          res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/octet-stream', 'cache-control': 'no-store' });
          pipeUpstream(ur, res, 'fetch');
        });
        up.on('error', e => {
          if (attempt < 3 && !res.headersSent) { log(`  fetch retry ${attempt}: ${e.message}`); setTimeout(go, 500); }
          else failUpstream(res, e.message, 'fetch');
        });
        up.end();
      };
      go();
      return;
    }
    if (req.url.startsWith('/getv?url=')) {
      // 外链媒体通道：把任意 https 资源（视频/图片）经本地代理取回，支持 Range。
      // 页面里的播放、抽帧（canvas 需要同源）、体积探测、下载都走它（见 README「统一路由（硬性约定）」），
      // 所以上游签名地址不会出现在任何 src 里。
      const target = await takeOutboundUrl(req, res, '/getv?url=', 'getv');
      if (!target) return;
      /* 与 /asset 同一条理由：切片/播放会连发许多 Range，别每条都重建 TLS（同 host 才复用）。 */
      const upHeaders = { 'user-agent': 'local-workbench' };
      if (req.headers.range) upHeaders.range = req.headers.range;
      const up = upRequest(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', keepAlive: true, headers: upHeaders }, ur => {
        /* 失败响应绝不缓存、Range 要原样透出、状态码不许压成 200 —— 判据在 passthroughHeaders（与 /asset 同一份）。 */
        const { st, h } = passthroughHeaders(ur.headers, {
          status: ur.statusCode,
          okType: ur.headers['content-type'] || 'video/mp4',
          cacheOk: 'public, max-age=86400',
          cors: true,
        });
        res.writeHead(st, h);
        pipeUpstream(ur, res, 'getv');
      });
      up.on('error', e => failUpstream(res, e.message, 'getv'));
      up.end();
      return;
    }
    return false;
  }

  return { handleOutbound };
}

module.exports = { createOutboundRoutes };
