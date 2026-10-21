#!/usr/bin/env node
/* 渲染任务台账：POST /render → /render/status → /render/jobs（落盘最近 50 单）
   → /render/dl → /render/save-to-assets，取消与越界路径的拒绝。只写探针目录。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const h = require('./harness.cjs');

function hasFfmpeg() {
  try { cp.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function makeClip(dir, sec) {
  const f = path.join(dir, 'probe-src.mp4');
  cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=12:duration=' + sec,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', f], { stdio: 'pipe' });
  return f;
}

function jfetch(pr, p, init) {
  const i = init || {};
  return fetch(pr.base + p, Object.assign({}, i, { headers: Object.assign({ cookie: pr.cookie }, i.headers || {}) }));
}

(async () => {
  let proxy, p2 = null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aii-render-'));
  try {
    proxy = await h.startProxy();
    const J = (p, init) => jfetch(proxy, p, init);
    const bad = [];

    /* 形状校验：没有 clips / clips 过多 / 字幕过多都当场 400，不入队、不记账。 */
    const noClips = await J('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    if (noClips.status !== 400) bad.push('缺 clips 没被 400：' + noClips.status);
    const subTooMany = await J('/render', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', clips: [{ src: '/asset/la_x', in: 0, out: 1 }],
        subtitles: Array.from({ length: 5001 }, (_, i) => ({ src: '/asset/la_p', start: 0, end: 1, i })) }) });
    if (subTooMany.status !== 400) bad.push('字幕超上限没被 400：' + subTooMany.status);
    if (bad.length) throw new Error(bad.join('；'));

    /* 未知任务：status / cancel 都 404，不报空对象。 */
    const st404 = await J('/render/status?id=r_nope');
    const cx404 = await J('/render/cancel?id=r_nope', { method: 'POST' });
    if (st404.status !== 404 || cx404.status !== 404) throw new Error('未知任务号没回 404：' + st404.status + '/' + cx404.status);

    /* 下载与存资产库的路径闸：name 只认 basename，扩展名白名单外一律拒。 */
    const trav = await J('/render/dl?name=' + encodeURIComponent('../../../.env'));
    if (trav.status !== 404) throw new Error('跨目录下载没被拒：' + trav.status);
    const saveBad = await J('/render/save-to-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../../package.json' }) });
    if (saveBad.status !== 400) throw new Error('非成片扩展名存资产库没被 400：' + saveBad.status);

    if (!hasFfmpeg()) { console.log('✓ 渲染路由校验通过（本机没有 ffmpeg，真实合成那一段跳过）'); return; }

    /* 一条 1 秒素材渲染成 1 秒成片（带一条字幕烧录），走完整台账。 */
    const clip = makeClip(work, 1);
    const b64 = fs.readFileSync(clip).toString('base64');
    const up = await J('/local-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-src.mp4', data: b64, format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }) });
    const src = await up.json();
    if (!src.id) throw new Error('本机资产造不出来：' + JSON.stringify(src));
    const png = path.join(work, 'sub.png');
    cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=black@0.0:s=128x72', '-frames:v', '1', png], { stdio: 'pipe' });
    const subUp = await J('/local-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sub.png', data: fs.readFileSync(png).toString('base64'), format: 'png', mime: 'image/png', meta: {} }) });
    const subAsset = await subUp.json();
    if (!subAsset.id) throw new Error('字幕图资产造不出来：' + JSON.stringify(subAsset));

    const submit = await J('/render', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '探针成片', clips: [{ src: '/asset/' + src.id, in: 0, out: 1 }],
        width: 128, height: 72, fps: 12, crf: 30, subtitles: [{ src: '/asset/' + subAsset.id, start: 0, end: 1 }] }) });
    const job = await submit.json();
    if (!job.id) throw new Error('提交渲染失败：' + JSON.stringify(job));

    let st = null;
    const until = Date.now() + 180000;
    while (Date.now() < until) {
      st = await J('/render/status?id=' + job.id).then(r => r.json());
      if (!['queued', 'running'].includes(st.state)) break;
      await h.sleep(800);
    }
    if (st.state !== 'done') throw new Error('渲染没跑完：' + JSON.stringify(st));
    if (!fs.existsSync(path.join(proxy.renderDir, path.basename(st.out)))) throw new Error('成片没落在 RENDER_DIR：' + st.out);

    /* 台账：/render/jobs 读的是 .data/render-jobs.json，任务对象回收后仍然查得到。 */
    const ledger = path.join(proxy.dataDir, 'render-jobs.json');
    if (!fs.existsSync(ledger)) throw new Error('渲染台账没落盘：' + ledger);
    const list = await J('/render/jobs').then(r => r.json());
    const row = (list.jobs || []).find(x => x.id === job.id);
    if (!row) throw new Error('台账里查不到这一单：' + JSON.stringify((list.jobs || []).map(x => x.id)));
    if (!row.exists || !(row.bytes > 0)) throw new Error('台账把这份成片标成不存在：' + JSON.stringify(row));
    if (row.url !== '/render/dl?name=' + encodeURIComponent(row.out)) throw new Error('下载地址不对：' + row.url);
    const dl = await J(row.url);
    const dlBytes = Buffer.from(await dl.arrayBuffer());
    if (dlBytes.length !== row.bytes) throw new Error('下载字节数与台账不符：' + dlBytes.length + ' vs ' + row.bytes);

    /* 存进资产库：同一份第二次应当 reused，不再复制一份。 */
    const s1 = await J('/render/save-to-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: row.out, title: '探针成片' }) }).then(r => r.json());
    if (!s1.ok || !s1.id) throw new Error('存资产库失败：' + JSON.stringify(s1));
    if (s1.bytes !== dlBytes.length) throw new Error('存进资产库的字节数不对：' + s1.bytes + ' vs ' + dlBytes.length);
    const s2 = await J('/render/save-to-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: row.out }) }).then(r => r.json());
    if (!s2.reused || s2.id !== s1.id) throw new Error('同一份成片存了两次：' + JSON.stringify(s2));
    const got = await J('/asset/' + s1.id);
    if (got.status !== 200) throw new Error('资产库里那一份取不回来：' + got.status);

    /* 取消：新单立刻取消，状态必须停在 cancelled（不假装成功）。 */
    const long = makeClip(work, 2);
    const up2 = await J('/local-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-long.mp4', data: fs.readFileSync(long).toString('base64'),
        format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }) }).then(r => r.json());
    const c1 = Array.from({ length: 24 }, (_, i) => ({ src: '/asset/' + up2.id, in: 0, out: 2, speed: 0.25 + i * 0.05 }));
    const j2 = await J('/render', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '探针取消单', clips: c1, width: 128, height: 72, fps: 12, crf: 30 }) }).then(r => r.json());
    const cx = await J('/render/cancel?id=' + j2.id, { method: 'POST' }).then(r => r.json());
    if (!cx.ok) throw new Error('取消失败：' + JSON.stringify(cx));
    await h.sleep(1500);
    const st2 = await J('/render/status?id=' + j2.id).then(r => r.json());
    if (st2.state !== 'cancelled') throw new Error('取消后状态不是 cancelled：' + st2.state);
    const ledger2 = await J('/render/jobs').then(r => r.json());
    const row2 = (ledger2.jobs || []).find(x => x.id === j2.id);
    if (!row2 || row2.state !== 'cancelled') throw new Error('台账没记下这一单被取消：' + JSON.stringify(row2));

    /* 队列上限：把闸门压到 1，第二条排不进去要当场 429 并写明上限。 */
    await proxy.stop(); proxy = null;
    p2 = await h.startProxy({ env: { RENDER_QUEUE_MAX: '1', RENDER_CONCURRENCY: '1' } });
    const J2 = (p, init) => jfetch(p2, p, init);
    /* 换一个实例就等于换一套探针目录：素材要在这台里重新存一份，clips 才指得到真字节。 */
    const up3 = await J2('/local-assets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-long.mp4', data: fs.readFileSync(long).toString('base64'),
        format: 'mp4', mime: 'video/mp4', media_type: 'video', meta: {} }) }).then(r => r.json());
    if (!up3.id) throw new Error('第二个实例里素材没存进去：' + JSON.stringify(up3));
    const body = JSON.stringify({ name: '探针排队单', clips: Array.from({ length: 40 }, () => ({ src: '/asset/' + up3.id, in: 0, out: 2 })),
      width: 128, height: 72, fps: 25, crf: 18 });
    const first = await J2('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (first.status !== 200) throw new Error('第一单就该进队：' + first.status);
    let codes = [];
    for (let i = 0; i < 6; i++) codes.push((await J2('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status);
    if (!codes.includes(429)) throw new Error('队列压满没有 429：' + codes.join(','));
    const rej = await (await J2('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
    if (!/渲染任务排队过多/.test(JSON.stringify(rej))) throw new Error('429 的理由没写清楚：' + JSON.stringify(rej));
    await p2.stop(); p2 = null;

    console.log('✓ 渲染任务台账通过（形状校验 / 路径闸 / 1 段带字幕合成 / 台账 exists+bytes / 下载字节一致 / 存资产库去重 / 取消入账 / 压满 429）');
  } catch (e) {
    console.error('✗ ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (proxy) await proxy.stop();
    if (p2) await p2.stop();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
})();
