/* /media/prepare-reference-video：给没有音轨的参考视频补一条静音 AAC 轨（ffmpeg，单任务限 2 条）。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function createMediaRoutes(ctx) {
  const { readBody, killJobProcs, probe, runFfmpeg, state, resolveSrc, downloadTo, localAssetFile, log } = ctx;

  /* POST /media/info {assetId? | src?} → {duration,width,height,hasAudio,hasVideo,format,bytes,...}
     为什么要它：导入一段素材以后，时间线需要真实时长 / 画幅 / 有没有原声；以前这些全靠前端
     `<video>` 元数据猜，遇到 mkv / 无音轨 / 图片就判错。ffprobe 只在代理这一层跑一次（15 秒上限）。
     素材来源三档：本机资产号（la_xxx）、/asset/<id>、已过护栏的外链 —— 后两档先落到临时文件再探。 */
  async function handleMediaInfo(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ error: { message: '媒体检查只接受 POST' } }));
      return;
    }
    const raw = await readBody(req, res, 64 * 1024);
    if (raw == null) return;
    let spec = {};
    try { spec = JSON.parse(raw.toString('utf8')) || {}; } catch {}
    const jid = 'mediainfo-' + require('crypto').randomUUID();
    const cancel = () => { if (!res.writableFinished) killJobProcs(jid); };
    res.on('close', cancel);
    let tmpDir = '';
    const fail = (code, msg) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { message: msg } }));
    };
    try {
      const assetId = String(spec.assetId || '').trim();
      const src = String(spec.src || '').trim();
      let file = '', bytes = 0;
      if (assetId) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(assetId)) return fail(400, '资产号不合法');
        file = localAssetFile(assetId) || '';
        if (!file) return fail(404, '本机资产库里没有这一条（或文件已经不在了）：' + assetId);
        bytes = fs.statSync(file).size;
      } else if (src) {
        const m = /^\/asset\/([A-Za-z0-9_-]+)/.exec(src);
        const local = m ? localAssetFile(m[1]) : '';
        if (local) {
          file = local;
          bytes = fs.statSync(file).size;
        } else {
          const key = (req.headers.authorization || '').replace(/^Bearer\s*/, '') || null;
          const url = await resolveSrc(src, key);
          tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aii-mediainfo-'));
          file = path.join(tmpDir, 'input');
          bytes = await downloadTo(url, file);
        }
      } else {
        return fail(400, '需要 assetId 或 src 之一');
      }
      const out = await probe(['-v', 'error', '-show_entries',
        'format=format_name,duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate',
        '-of', 'json', file], jid);
      if (res.destroyed) return;
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (!j) return fail(422, 'ffprobe 没有给出可读的结果（文件可能损坏，或本机没装 ffprobe）');
      const streams = Array.isArray(j.streams) ? j.streams : [];
      const v = streams.find(s => s && s.codec_type === 'video') || null;
      const a = streams.find(s => s && s.codec_type === 'audio') || null;
      const fmt = (j.format && j.format.format_name) || '';
      const duration = Math.max(0, Number(j.format && j.format.duration) || 0);
      const fps = v && /^\d+\/\d+$/.test(String(v.avg_frame_rate || ''))
        ? (() => { const [n, d] = String(v.avg_frame_rate).split('/').map(Number); return d ? Math.round(n / d * 100) / 100 : 0; })()
        : 0;
      log(`[media] 检查 ${assetId || src.slice(0, 80)}：${duration.toFixed(2)}s ${v ? (v.width + '×' + v.height) : '无画面'}`
        + `${a ? ' 有声音' : ' 无声音'}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        duration, width: v ? Number(v.width) || 0 : 0, height: v ? Number(v.height) || 0 : 0,
        hasVideo: !!v, hasAudio: !!a,
        /* 图片也会被 ffprobe 当成 video 流报出来，但没有时长 —— 单独标出来，
           时间线据此给它一个默认时长，而不是当成一段 0 秒的视频。 */
        still: !!v && !duration,
        fps, vcodec: v ? String(v.codec_name || '') : '', acodec: a ? String(a.codec_name || '') : '',
        format: fmt, bytes: Number(j.format && j.format.size) || bytes,
      }));
    } catch (e) {
      fail(422, '媒体检查失败：' + e.message);
    } finally {
      res.removeListener('close', cancel);
      killJobProcs(jid);
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  async function handlePrepareReferenceVideo(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ error: { message: '视频预处理只接受 POST' } }));
      return;
    }
    if (state.preparing >= 2) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '正在处理其他参考视频，请稍后重试' } }));
      return;
    }
    state.preparing++;
    let dir = '', timer;
    const jid = 'media-' + require('crypto').randomUUID();
    const cancel = () => { if (!res.writableFinished) killJobProcs(jid); };
    res.on('close', cancel);
    try {
      const raw = await readBody(req, res, 200 * 1024 * 1024);
      if (raw == null || res.destroyed) return;
      if (!raw.length) throw new Error('参考视频为空');
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aii-reference-'));
      const input = path.join(dir, 'input');
      const output = path.join(dir, 'prepared.mp4');
      await fs.promises.writeFile(input, raw);
      // 禁止用户上传的播放列表让 ffmpeg 读取其他本机文件或网络地址。
      const safeInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,ogg,flv,mpegts'];
      const info = await probe(['-v', 'error', ...safeInput, '-show_entries', 'stream=codec_type', '-of', 'json', input], jid);
      if (res.destroyed) return;
      let streams;
      try { streams = JSON.parse(info).streams; } catch {}
      if (!Array.isArray(streams) || !streams.some(s => s.codec_type === 'video')) {
        throw new Error('无法识别视频，请使用有效的 MP4/MOV/WebM 文件，并确认 ffprobe 已安装');
      }
      if (streams.some(s => s.codec_type === 'audio')) {
        const mime = /^video\/[a-z0-9.+-]+$/i.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Audio-Added': '0' });
        res.end(raw);
        return;
      }
      timer = setTimeout(() => killJobProcs(jid), 120000);
      await runFfmpeg(['-nostdin', '-y', ...safeInput, '-i', input,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
        '-shortest', '-movflags', '+faststart', output], null, jid);
      if (res.destroyed) return;
      const st = await fs.promises.stat(output);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Audio-Added': '1' });
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(output);
        const finish = () => { stream.destroy(); resolve(); };
        res.once('finish', finish);
        res.once('close', finish);
        stream.once('error', reject);
        stream.pipe(res);
      });
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(422, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { message: '参考视频预处理失败：' + e.message } }));
      } else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);
      res.removeListener('close', cancel);
      killJobProcs(jid);
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      state.preparing--;
    }
  }

  return { handlePrepareReferenceVideo, handleMediaInfo };
}

module.exports = { createMediaRoutes };
