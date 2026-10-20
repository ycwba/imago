/* 渲染路由：POST /render（入队）/ status / cancel / dl。
   ffmpeg 合成与队列本身仍在 app；这里只做请求解析、任务对象与响应。 */
'use strict';
const fs = require('fs');
const path = require('path');

function createRenderRoutes(ctx) {
  const readBody = ctx.readBody;
  const log = ctx.log;
  const renders = ctx.renders;
  const renderQueue = ctx.renderQueue;
  const running = ctx.running;
  const enqueueRender = ctx.enqueueRender;
  const killJobProcs = ctx.killJobProcs;
  const pruneRenders = ctx.pruneRenders;
  const sendFileWithRange = ctx.sendFileWithRange;
  const keyOf = ctx.keyOf;
  const assetStore = ctx.assetStore;
  const fileSafe = ctx.fileSafe;
  const RENDER_DIR = ctx.RENDER_DIR;
  const RENDER_CLIPS_MAX = ctx.RENDER_CLIPS_MAX;
  const RENDER_QUEUE_MAX = ctx.RENDER_QUEUE_MAX;
  const VOICE_MAX = ctx.VOICE_MAX;
  const SUBTITLE_MAX = ctx.SUBTITLE_MAX || 2000;
  const renderJobs = ctx.renderJobs;          // 最近 50 单（.data/render-jobs.json）
  const saveLocalCopy = ctx.saveLocalCopy;    // 「存到资产库」：本地资产索引只有一条写法

  function handleRender(req, res, pathname, urlObj) {
      if (req.url.startsWith('/render/status')) {
        const id = urlObj.searchParams.get('id');
        const job = renders.get(id);
        if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"任务不存在"}'); return true; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ id: job.id, state: job.state, progress: job.progress, stage: job.stage,
          out: job.out, size: job.size, err: job.err, keepAudio: job.keepAudio, queuePos: job.queuePos,
          log: (job.log || []).slice(-14) }));
        return true;
      }
      if (req.url.startsWith('/render/cancel')) {
        // 取消渲染：杀掉正在跑的 ffmpeg 子进程，并从队列里摘掉
        const id = urlObj.searchParams.get('id');
        const job = renders.get(id);
        if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"任务不存在"}'); return true; }
        job.state = 'cancelled';
        const qi = renderQueue.indexOf(job);
        if (qi >= 0) renderQueue.splice(qi, 1);
        const killed = killJobProcs(id);
        log(`[render] 取消 ${id}（杀掉 ${killed} 个 ffmpeg 进程）`);
        try { renderJobs.record(job); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, id, killed }));
        return true;
      }
      if (req.url.startsWith('/render/dl')) {
        const name = path.basename(urlObj.searchParams.get('name') || '');
        const f = path.join(RENDER_DIR, name);
        if (!name || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
        /* Content-Type 按扩展名给：这一目录现在不只放 mp4（「导出素材」的每句配音是 m4a）。
           一律当 video/mp4 的话，浏览器会把 .m4a 也按视频处理，个别环境直接拒下载。 */
        const ct = /\.m4a$/i.test(name) ? 'audio/mp4'
          : /\.wav$/i.test(name) ? 'audio/wav'
          : /\.mp3$/i.test(name) ? 'audio/mpeg' : 'video/mp4';
        sendFileWithRange(req, res, f, { 'Content-Type': ct, 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"' });
        return true;
      }
      /* 最近导出：任务对象 5 分钟后会被回收，这里读的是落盘的索引；
         文件被人删过的单子照实标 exists:false（别给一个点了 404 的下载按钮）。 */
      if (urlObj.pathname === '/render/jobs' && req.method === 'GET') {
        const live = new Map();
        renders.forEach(j => live.set(j.id, j));
        const jobs = renderJobs.all().map(j => {
          const lj = live.get(j.id);
          const state = lj ? lj.state : j.state;
          const f = j.out ? path.join(RENDER_DIR, path.basename(j.out)) : '';
          let exists = false, bytes = j.bytes, mtime = 0;
          try { const st = fs.statSync(f); exists = st.isFile(); bytes = st.size; mtime = st.mtimeMs; } catch {}
          return { ...j, state, bytes, exists, mtime: mtime || j.updatedAt,
            progress: lj ? lj.progress : (state === 'done' ? 100 : 0),
            url: exists ? '/render/dl?name=' + encodeURIComponent(j.out) : null };
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ jobs, limit: renderJobs.LIMIT }));
        return true;
      }
      /* 把渲染目录里的成品复制一份进本机资产库（素材库 / 素材选择器马上就能用）。
         文件只从 RENDER_DIR 里按 basename 取，请求体里的路径一律不认。 */
      if (urlObj.pathname === '/render/save-to-assets' && req.method === 'POST') {
        readBody(req, res, 64 * 1024).then(buf => {
          if (buf == null) return;
          let spec = {};
          try { spec = JSON.parse(buf.toString('utf8')) || {}; } catch {}
          const name = path.basename(String(spec.name || ''));
          const ext = path.extname(name).toLowerCase();
          const fail = (code, msg) => {
            res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: { message: msg } }));
          };
          if (!name || !/^\.(mp4|m4a|wav|mp3|mov|webm)$/i.test(ext)) return fail(400, '这不是一份可保存的成片文件');
          const f = path.join(RENDER_DIR, name);
          if (!fs.existsSync(f)) return fail(404, '这份成片已经不在了（可能被手动删过）：' + name);
          try {
            const item = saveLocalCopy(f, { marker: name, title: String(spec.title || '').slice(0, 200) });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, id: item.id, url: item.url, name: item.name,
              bytes: item.byte_length, reused: !!item.reused }));
          } catch (e) {
            const msg = e && e.indexWrite
              ? ('字节已经复制进 .assets 了，但索引没写成：' + e.message + '。腾出磁盘空间后再点一次')
              : e.message;
            log('[render] 成品存资产库失败：' + e.message);
            fail(500, msg);
          }
        });
        return true;
      }
      if (req.url.startsWith('/render') && req.method === 'POST') {
        readBody(req, res, 8 * 1024 * 1024).then(buf => {
          if (buf == null) return;                    // 超限已回 413
          let spec = null;
          try { spec = JSON.parse(buf.toString('utf8')); } catch {}
          if (!spec || !Array.isArray(spec.clips) || !spec.clips.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"缺少 clips"}'); return;
          }
          if (spec.clips.length > RENDER_CLIPS_MAX) {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"片段过多（上限 ' + RENDER_CLIPS_MAX + ' 段）"}'); return;
          }
          /* 字幕：客户端已经把每一条烧成一张与成片同尺寸的透明 PNG。
             这里只做形状与条数校验；start/end 是**成片秒**（与 clips 的同一条轴）。
             超过上限当场 400 —— 截断等于静默丢字幕，比整单不生成更糟。 */
          const subsIn = Array.isArray(spec.subtitles) ? spec.subtitles : [];
          if (subsIn.length > SUBTITLE_MAX) {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"字幕条数过多（上限 ' + SUBTITLE_MAX + ' 条）"}'); return;
          }
          const subtitles = subsIn.map(s => ({
            src: String((s && s.src) || '').slice(0, 2000),
            start: Math.max(0, Number(s && s.start) || 0),
            end: Math.max(0, Number(s && s.end) || 0),
          })).filter(s => s.src && s.end > s.start);
          // 队列上限：避免一次性提交几百个渲染任务把 CPU 与磁盘占满
          if (renderQueue.length + (running() || 0) >= RENDER_QUEUE_MAX) {
            res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"渲染任务排队过多（在跑与排队最多 ' + RENDER_QUEUE_MAX + ' 条），稍后再试"}'); return;
          }
          const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const job = {
            id, state: 'queued', progress: 1, stage: '排队', log: [], out: null, err: null, size: 0, ts: Date.now(),
            createdAt: Date.now(),
            key: (req.headers.authorization || '').replace(/^Bearer\s*/, '') || (assetStore ? keyOf(assetStore.keyEnv) : ''),
            name: fileSafe(spec.name || '成片', 60),
            spec: {
              /* clips 里额外放行 volume 与 voices；
                 voices 是这一段的**逐句配音**（时间相对本段起点，合成时按各自的 start 延迟混进去）。
                 两者都只做形状校验，取值范围在 renderJob 里夹紧 —— 不要在这里直接信任客户端 */
              clips: spec.clips.map(c => ({
                src: c && c.src, in: c && c.in, out: c && c.out, speed: c && c.speed, volume: c && c.volume,
                /* `off` = 这一句在**音频文件内部**的起点（客户端拖左把手剪掉开头时写的）。
                   ⚠ 它以前在这里被漏掉 —— 路由的这段是**逐字段重写**的，不是原样透传，
                   所以 renderJob 里读得到 v.off，客户端也发了，这中间这一层却没放行：
                   结果是「剪切过开头的那一句」合成时又从音频第 0 秒整句放出来
                   （试听/预览听得到剪掉的那一截，成片里也在）。三处口径：clipVoices / 这里 / renderJob。 */
                /* `spd` = 这一句自己的倍速（乘在本段 speed 之上）。它与 `off` 是同一类字段：
                   这一段是**逐字段重写**的，不是原样透传 —— 这里漏放行，客户端发了、renderJob 里也读得到，
                   中间这一层把它当成没有，成片就永远是原速（预览与回执却说变了速）。 */
                voices: (c && Array.isArray(c.voices) ? c.voices.slice(0, VOICE_MAX) : []).map(v => ({
                  src: String(v && v.src || '').slice(0, 2000), start: Math.max(0, Number(v && v.start) || 0),
                  dur: Math.max(0, Number(v && v.dur) || 0), vol: Number.isFinite(Number(v && v.vol)) ? Number(v.vol) : 1,
                  off: Math.max(0, Number(v && v.off) || 0),
                  spd: Math.max(0.25, Math.min(4, Number(v && v.spd) || 1)),
                })).filter(v => v.src),
              })),
              width: Math.max(64, Math.min(4096, parseInt(spec.width) || 1280)),
              height: Math.max(64, Math.min(4096, parseInt(spec.height) || 720)),
              fps: Math.max(12, Math.min(60, parseInt(spec.fps) || 30)),
              crf: Math.max(14, Math.min(32, parseInt(spec.crf) || 20)),
              bgm: spec.bgm || null,
              /* 只出音频（导演台「导出素材」里每句配音一个文件那一条路）。只做布尔化，
                 客户端传什么类型都只当 true/false —— 这里是要不要走 `-vn` 的开关，不是用户输入。 */
              audioOnly: !!spec.audioOnly,
              /* 烧录字幕：每条一张透明 PNG（src 走 /asset/ 或公网 https），start/end 是成片秒。
                 只有出视频时才用；audioOnly 由 renderJob 忽略。 */
              subtitles,
            },
          };
          renders.set(id, job);
          pruneRenders();
          try { renderJobs.record(job); } catch {}
          log(`[render] 新任务 ${id}：${job.spec.clips.length} 段 → ${job.spec.width}×${job.spec.height}@${job.spec.fps}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id }));
          enqueueRender(job);
        });
        return true;
      }
      return false;
  }
  return { handleRender };
}

module.exports = { createRenderRoutes };
